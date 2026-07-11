//! Read + annotate side of the mirrored canvas signals.
//!
//! NOTE: this module is legacy V2. Storage has moved to the unified
//! `feed_events` table (`event_type = 'signal'`). Notes live in
//! `feed_event_notes`. These endpoints keep the original V2 API shape.

use std::collections::HashMap;
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions;
use crate::{AppState, auth::AuthUser};

const SIGNAL_IMAGE_BASE: &str = "https://signal.filianislost.com/static/uploads/";

#[derive(Debug, Serialize)]
pub struct SignalView {
    pub id: Uuid,
    pub num_id: Option<i64>,
    pub external_id: Option<String>,
    pub tag: Option<String>,
    pub name: Option<String>,
    pub location: Option<String>,
    pub image_file: Option<String>,
    pub image_url: Option<String>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub sampled_at: DateTime<Utc>,
    pub notes: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub since: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct RawRow {
    id: Uuid,
    external_id: String,
    tag: Option<String>,
    payload: serde_json::Value,
    sampled_at: DateTime<Utc>,
}

fn build_view(r: RawRow, notes: HashMap<String, String>) -> SignalView {
    let p = &r.payload;

    let submitted_at = p
        .get("submitted_at")
        .and_then(|v| match v {
            serde_json::Value::String(s) => s.parse::<i64>().ok(),
            serde_json::Value::Number(n) => n.as_i64(),
            _ => None,
        })
        .and_then(DateTime::<Utc>::from_timestamp_millis);

    let image_file = p
        .get("image_file")
        .and_then(|v| v.as_str())
        .map(String::from);
    let image_url = image_file
        .as_ref()
        .map(|f| format!("{SIGNAL_IMAGE_BASE}{f}"));
    let num_id = p.get("num_id").and_then(|v| v.as_i64());

    SignalView {
        id: r.id,
        num_id,
        external_id: Some(r.external_id),
        tag: r.tag.filter(|s| !s.is_empty()),
        name: p.get("name").and_then(|v| v.as_str()).map(String::from),
        location: p.get("location").and_then(|v| v.as_str()).map(String::from),
        image_file,
        image_url,
        submitted_at,
        sampled_at: r.sampled_at,
        notes,
    }
}

pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<SignalView>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows: Vec<RawRow> = sqlx::query_as(
        r#"SELECT id, external_id, payload->>'tag' AS tag, payload, occurred_at AS sampled_at
             FROM feed_events
            WHERE event_type = 'signal'
              AND ($1::timestamptz IS NULL OR occurred_at > $1)
            ORDER BY occurred_at DESC
            LIMIT $2"#,
    )
    .bind(q.since)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let notes_rows: Vec<(Uuid, String, String)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT event_id, lang, note FROM feed_event_notes WHERE event_id = ANY($1)")
            .bind(&ids[..])
            .fetch_all(&state.pool)
            .await
            .or_500()?
    };

    let mut by_id: HashMap<Uuid, HashMap<String, String>> = HashMap::new();
    for (eid, lang, note) in notes_rows {
        by_id.entry(eid).or_default().insert(lang, note);
    }

    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let n = by_id.remove(&r.id).unwrap_or_default();
                build_view(r, n)
            })
            .collect(),
    ))
}

pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SignalView>, (StatusCode, String)> {
    let r: RawRow = sqlx::query_as(
        r#"SELECT id, external_id, payload->>'tag' AS tag, payload, occurred_at AS sampled_at
             FROM feed_events
            WHERE id = $1 AND event_type = 'signal'"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?
    .ok_or((StatusCode::NOT_FOUND, "signal not found".into()))?;

    let notes_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT lang, note FROM feed_event_notes WHERE event_id = $1")
            .bind(id)
            .fetch_all(&state.pool)
            .await
            .or_500()?;
    let notes: HashMap<String, String> = notes_rows.into_iter().collect();
    Ok(Json(build_view(r, notes)))
}

#[derive(Debug, Deserialize)]
pub struct UpsertNote {
    pub lang: String,
    pub note: String,
}

pub async fn upsert_note(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<UpsertNote>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    // Verify the target event exists and is a signal.
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM feed_events WHERE id = $1 AND event_type = 'signal')",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    if !exists {
        return Err((StatusCode::NOT_FOUND, "signal not found".into()));
    }

    let lang = b.lang.trim().to_ascii_lowercase();
    if !matches!(lang.as_str(), "en" | "ru" | "de" | "fr") {
        return Err((StatusCode::BAD_REQUEST, "unsupported lang".into()));
    }
    if b.note.trim().is_empty() {
        sqlx::query("DELETE FROM feed_event_notes WHERE event_id = $1 AND lang = $2")
            .bind(id)
            .bind(&lang)
            .execute(&state.pool)
            .await
            .or_500()?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if b.note.chars().count() > 2000 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "max 2000 chars".into()));
    }

    sqlx::query(
        r#"INSERT INTO feed_event_notes (event_id, lang, note, author_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (event_id, lang) DO UPDATE
             SET note = EXCLUDED.note, author_id = EXCLUDED.author_id, updated_at = NOW()"#,
    )
    .bind(id)
    .bind(&lang)
    .bind(&b.note)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::OK)
}
