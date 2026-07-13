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
    // Email linking was removed in V3 (migration 023 dropped email_link_requests).
    Ok(Json(Vec::new()))
}

pub async fn approve_email_request(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    // Email linking was removed in V3 (migration 023 dropped email_link_requests).
    Err((StatusCode::GONE, "email linking has been removed".into()))
}

pub async fn reject_email_request(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(_id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    // Email linking was removed in V3 (migration 023 dropped email_link_requests).
    Err((StatusCode::GONE, "email linking has been removed".into()))
}
