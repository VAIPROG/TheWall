use axum::{Json, response::IntoResponse};

/// GET /api/announcements
/// Stub: returns empty list until announcement storage is implemented.
pub async fn list() -> impl IntoResponse {
    Json(Vec::<serde_json::Value>::new())
}
