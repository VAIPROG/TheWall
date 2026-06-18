use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::{AppState, auth::AuthUser, models::ChatRelayRequest};

/// POST /api/chat/relay
/// Stub: accepts a relay message and returns 200 OK.
pub async fn relay(
    _auth: AuthUser,
    State(_state): State<AppState>,
    Json(_body): Json<ChatRelayRequest>,
) -> impl IntoResponse {
    StatusCode::OK
}
