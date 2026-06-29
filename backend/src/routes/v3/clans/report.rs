//! POST /api/v3/clans/{id}/report — report a clan to global moderators.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, models::ClanReportCreate};

use super::load_clan;

pub async fn report_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanReportCreate>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    // ── clan existence check ──────────────────────────────────────────────────
    load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // ── validate reason ───────────────────────────────────────────────────────
    let reason = body.reason.trim().to_string();
    if reason.len() < 10 || reason.len() > 2000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "reason must be 10–2000 characters".to_string(),
        ));
    }

    // ── validate evidence ─────────────────────────────────────────────────────
    if let Some(ref ev) = body.evidence {
        if ev.len() > 5000 {
            return Err((
                StatusCode::BAD_REQUEST,
                "evidence must be ≤ 5000 characters".to_string(),
            ));
        }
    }

    // ── insert report ─────────────────────────────────────────────────────────
    sqlx::query(
        r#"INSERT INTO clan_reports (id, clan_id, reporter_id, reason, evidence)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)"#,
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .bind(&reason)
    .bind(body.evidence.as_deref())
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "ok": true, "message": "report submitted" })),
    ))
}
