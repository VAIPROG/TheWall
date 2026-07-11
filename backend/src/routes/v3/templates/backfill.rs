//! POST /api/v3/admin/templates/backfill-documents
//!
//! One-shot admin job: for every template row whose `document` column is NULL
//! (i.e. legacy share-based rows that pre-date the v3 document column), decode
//! the `share` field via `crate::formats::decode_share` and write the resulting
//! the-wall-dev/2 document back into `document`.
//!
//! Returns a summary of how many rows were scanned, migrated, failed, and how
//! many still remain (NULL document) after the batch completes.
//!
//! Admin-only (global admin or owner). Processes up to 1 000 rows per call.
use crate::http_error::ResultExt;

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde_json::json;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, routes::v3::utils::permissions};

pub async fn backfill(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    // Pull up to 1 000 rows that still need a document.
    let rows: Vec<(Uuid, Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT id, user_id, name, share, created_at
             FROM templates
            WHERE document IS NULL
            LIMIT 1000"#,
    )
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let scanned = rows.len();
    let mut migrated: usize = 0;
    let mut failed: usize = 0;

    for (id, user_id, name, share, created_at) in rows {
        match crate::formats::decode_share(&share, &name, user_id, created_at) {
            Ok(doc) => {
                let res = sqlx::query(
                    "UPDATE templates SET document = $1 WHERE id = $2",
                )
                .bind(&doc)
                .bind(id)
                .execute(&state.pool)
                .await;

                match res {
                    Ok(_) => {
                        migrated += 1;
                        tracing::debug!("backfill-documents: migrated id={id}");
                    }
                    Err(e) => {
                        failed += 1;
                        tracing::warn!("backfill-documents: UPDATE failed id={id}: {e}");
                    }
                }
            }
            Err(e) => {
                failed += 1;
                tracing::debug!("backfill-documents: decode failed id={id}: {e}");
            }
        }
    }

    // Count how many rows still remain unmigrated.
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM templates WHERE document IS NULL",
    )
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    tracing::info!(
        "backfill-documents complete: scanned={scanned} migrated={migrated} \
         failed={failed} remaining={remaining}"
    );

    Ok(Json(json!({
        "scanned": scanned,
        "migrated": migrated,
        "failed": failed,
        "remaining": remaining,
    })))
}
