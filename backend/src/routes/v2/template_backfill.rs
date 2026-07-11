//! POST /api/v2/admin/templates/backfill-previews
//!
//! Iterates every template that doesn't yet have a row in `template_previews`
//! and generates the 64/128/256 thumbnails for it. Returns a summary of how
//! many succeeded, were skipped (undecodable share), or already cached.
//!
//! Admin-only — heavy job, can spin for a while on large catalogues.

use axum::{Json, extract::State, http::StatusCode};
use crate::http_error::ResultExt;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use serde::Serialize;
use std::io::Cursor;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

use super::permissions;

#[derive(Debug, Serialize)]
pub struct BackfillSummary {
    pub scanned: usize,
    pub generated: usize,
    pub skipped_undecodable: usize,
    pub skipped_already_cached: usize,
    pub failed: usize,
}

fn decode_data_url(s: &str) -> Option<Vec<u8>> {
    let rest = s.strip_prefix("data:image/")?;
    let b64 = rest.split_once(',')?.1;
    BASE64.decode(b64).ok()
}

fn decode_share(share: &str) -> Option<Vec<u8>> {
    if let Some(rest) = share.strip_prefix("the-wall-dev://") {
        let json_bytes = BASE64.decode(rest).ok()?;
        let json_str = std::str::from_utf8(&json_bytes).ok()?;
        let v: serde_json::Value = serde_json::from_str(json_str).ok()?;
        let data_url = v.get("src")?.as_str()?;
        return decode_data_url(data_url);
    }
    if share.starts_with("data:image/") {
        return decode_data_url(share);
    }
    None
}

fn encode_webp_nearest(bytes: &[u8], side: u32) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;
    let img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    let img = img.resize_exact(side, side, image::imageops::FilterType::Nearest);
    let rgba = img.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    Ok(encoder.encode(80.0).to_vec())
}

pub async fn backfill_previews(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<BackfillSummary>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    // Pull every template id + share that doesn't have a preview row yet.
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        r#"SELECT t.id, t.share
             FROM templates t
        LEFT JOIN template_previews p ON p.template_id = t.id
            WHERE p.template_id IS NULL"#,
    )
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let mut summary = BackfillSummary {
        scanned: rows.len(),
        generated: 0,
        skipped_undecodable: 0,
        skipped_already_cached: 0,
        failed: 0,
    };

    for (id, share) in rows {
        let raw = match decode_share(&share) {
            Some(b) => b,
            None => {
                summary.skipped_undecodable += 1;
                tracing::debug!("backfill: id={id} undecodable share");
                continue;
            }
        };
        let (w64, w128, w256) = match (
            encode_webp_nearest(&raw, 64),
            encode_webp_nearest(&raw, 128),
            encode_webp_nearest(&raw, 256),
        ) {
            (Ok(a), Ok(b), Ok(c)) => (a, b, c),
            (a, b, c) => {
                tracing::warn!(
                    "backfill: id={id} encode failed (64={:?}, 128={:?}, 256={:?})",
                    a.is_err(), b.is_err(), c.is_err(),
                );
                summary.failed += 1;
                continue;
            }
        };
        let r = sqlx::query(
            r#"INSERT INTO template_previews (template_id, preview_64, preview_128, preview_256)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (template_id) DO NOTHING"#,
        )
        .bind(id)
        .bind(&w64)
        .bind(&w128)
        .bind(&w256)
        .execute(&state.pool)
        .await;
        match r {
            Ok(res) if res.rows_affected() > 0 => summary.generated += 1,
            Ok(_) => summary.skipped_already_cached += 1,
            Err(e) => {
                tracing::warn!("backfill: id={id} insert err {}", e);
                summary.failed += 1;
            }
        }
    }
    tracing::info!(
        "backfill complete: scanned={} generated={} skipped_undecodable={} skipped_already_cached={} failed={}",
        summary.scanned, summary.generated, summary.skipped_undecodable,
        summary.skipped_already_cached, summary.failed,
    );
    Ok(Json(summary))
}
