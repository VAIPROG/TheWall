//! Read-side endpoints for the mirrored signals + persisted snapshot URLs.
//!
//! NOTE: this module is legacy V2. The underlying `wall_snapshots` table has
//! been replaced by the unified `feed_events` table. These endpoints project
//! rows with `event_type = 'snapshot'` back into the original V2 shape so
//! existing clients keep working.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct SnapshotQuery {
    /// Optional size filter ("small" | "medium" | "large"). When set we
    /// return exactly `limit` rows of that size — i.e. `limit` snapshots.
    pub size: Option<String>,
    /// Number of distinct *snapshots* the caller wants. Defaults to 20.
    /// Internally, when no `size` filter is provided we multiply the SQL
    /// LIMIT so each requested snapshot still arrives with all three sizes
    /// attached — see the bug-fix note below.
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct SnapshotRow {
    pub id: Uuid,
    pub size: String,
    pub bytes: Option<i64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// Direct cdn.discordapp.com attachment URL — usable as <img src>.
    pub discord_url: Option<String>,
    /// Public Telegram channel post URL (t.me/<channel>/<msg_id>).
    pub telegram_url: Option<String>,
    pub batch_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

const SIZES_PER_BATCH: i64 = 3;

pub async fn list_snapshots(
    State(state): State<AppState>,
    Query(q): Query<SnapshotQuery>,
) -> Result<Json<Vec<SnapshotRow>>, (StatusCode, String)> {
    let requested = q.limit.unwrap_or(20).clamp(1, 100);
    let sql_limit = if q.size.is_some() {
        requested
    } else {
        requested.saturating_mul(SIZES_PER_BATCH).min(500)
    };

    let rows = if let Some(size) = q.size.as_deref() {
        sqlx::query_as::<_, SnapshotRow>(
            r#"SELECT e.id,
                      $1::text AS size,
                      (e.payload->'sizes'->$1->>'bytes')::bigint AS bytes,
                      (e.payload->'sizes'->$1->>'width')::int AS width,
                      (e.payload->'sizes'->$1->>'height')::int AS height,
                      e.payload->'sizes'->$1->>'discordUrl' AS discord_url,
                      e.payload->'sizes'->$1->>'telegramUrl' AS telegram_url,
                      (e.payload->>'batchId')::uuid AS batch_id,
                      e.occurred_at AS created_at
                 FROM feed_events e
                WHERE e.event_type = 'snapshot'
                  AND e.payload->'sizes' ? $1
                ORDER BY e.occurred_at DESC
                LIMIT $2"#,
        )
        .bind(size)
        .bind(sql_limit)
        .fetch_all(&state.pool)
        .await
    } else {
        sqlx::query_as::<_, SnapshotRow>(
            r#"SELECT (e.payload->'sizes'->k->>'id')::uuid AS id,
                      k AS size,
                      (e.payload->'sizes'->k->>'bytes')::bigint AS bytes,
                      (e.payload->'sizes'->k->>'width')::int AS width,
                      (e.payload->'sizes'->k->>'height')::int AS height,
                      e.payload->'sizes'->k->>'discordUrl' AS discord_url,
                      e.payload->'sizes'->k->>'telegramUrl' AS telegram_url,
                      (e.payload->>'batchId')::uuid AS batch_id,
                      e.occurred_at AS created_at
                 FROM feed_events e,
                      jsonb_object_keys(e.payload->'sizes') k
                WHERE e.event_type = 'snapshot'
                ORDER BY e.occurred_at DESC, k
                LIMIT $1"#,
        )
        .bind(sql_limit)
        .fetch_all(&state.pool)
        .await
    }
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}
