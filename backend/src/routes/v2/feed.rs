//! Read-side endpoints for the mirrored signals + persisted snapshot URLs.

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
    /// LIMIT by SIZES_PER_BATCH so each requested snapshot still arrives
    /// with all three sizes attached — see the bug-fix note below.
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

/// Each snapshot batch inserts one row per size (small / medium / large), so
/// "N batches" corresponds to roughly `N * SIZES_PER_BATCH` rows. Used to
/// fix the limit-mismatch bug where `?limit=30` previously returned 10
/// snapshot batches (30 rows ÷ 3 sizes).
const SIZES_PER_BATCH: i64 = 3;

pub async fn list_snapshots(
    State(state): State<AppState>,
    Query(q): Query<SnapshotQuery>,
) -> Result<Json<Vec<SnapshotRow>>, (StatusCode, String)> {
    let requested = q.limit.unwrap_or(20).clamp(1, 100);
    // Bug fix: when no size filter is set, the caller is asking for N
    // *snapshots* (each carrying S/M/L), not N rows. Multiply the SQL LIMIT
    // by SIZES_PER_BATCH so the caller actually gets ~N batches' worth of
    // rows. When a size filter IS set, one row = one snapshot, so the
    // original limit applies directly.
    let sql_limit = if q.size.is_some() {
        requested
    } else {
        requested.saturating_mul(SIZES_PER_BATCH).min(500)
    };
    let rows = sqlx::query_as::<_, SnapshotRow>(
        r#"SELECT id, size, bytes, width, height,
                  discord_url, telegram_url,
                  batch_id, created_at
             FROM wall_snapshots
            WHERE ($1::text IS NULL OR size = $1)
            ORDER BY created_at DESC
            LIMIT $2"#,
    )
    .bind(q.size.as_deref())
    .bind(sql_limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}
