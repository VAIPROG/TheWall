//! Admin side of the email-link flow: list pending requests, approve them
//! (which stamps the proposed email onto the user record), or reject.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use crate::http_error::ResultExt;
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions;
use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, FromRow)]
pub struct EmailRequestRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub proposed_email: String,
    pub code: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
}

pub async fn list_email_requests(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<EmailRequestRow>>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, EmailRequestRow>(
        r#"SELECT r.id, r.user_id, u.username,
                  r.proposed_email, r.code, r.status,
                  r.created_at, r.decided_at
             FROM email_link_requests r
             JOIN users u ON u.id = r.user_id
            ORDER BY (r.status = 'pending') DESC, r.created_at DESC
            LIMIT 200"#,
    )
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

pub async fn approve_email_request(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "SELECT user_id, proposed_email, status FROM email_link_requests WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    let row = row.ok_or((StatusCode::NOT_FOUND, "request not found".into()))?;
    if row.2 != "pending" {
        return Err((StatusCode::CONFLICT, "request already decided".into()));
    }

    let mut tx = state
        .pool
        .begin()
        .await
        .or_500()?;
    // NOTE: `users.notifications_email` was dropped in migration 023 (V3
    // identity). This legacy email-link approval no longer stores the address;
    // it only marks the request approved below. (`row.1` = the requested email
    // is intentionally unused now.)
    let _ = &row.1;
    sqlx::query(
        "UPDATE email_link_requests SET status = 'approved', decided_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .or_500()?;
    tx.commit()
        .await
        .or_500()?;
    Ok(StatusCode::OK)
}

pub async fn reject_email_request(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    sqlx::query(
        "UPDATE email_link_requests SET status = 'rejected', decided_at = NOW() WHERE id = $1 AND status = 'pending'",
    )
    .bind(id).execute(&state.pool).await
    .or_500()?;
    Ok(StatusCode::OK)
}
