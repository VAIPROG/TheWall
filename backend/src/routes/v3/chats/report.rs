//! Message report handler:
//!   POST /api/v3/chats/{cid}/messages/{mid}/report

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::ReportCreate,
    routes::v3::utils::sanctions,
};

use super::resolve::{can_access_chat, load_chat};

// ---------------------------------------------------------------------------
// POST /api/v3/chats/{chat_id}/messages/{message_id}/report
// ---------------------------------------------------------------------------

pub async fn report_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ReportCreate>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, String)> {
    // Load chat — 404 if absent.
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    // Access check — 403 if the viewer can't see this chat.
    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    // Enforcement: SendReports blocks submitting reports (clan-scoped when the
    // chat is tied to a clan).
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::SendReports, chat.clan_id)],
    )
    .await?;

    // Verify the message exists in this chat.
    let msg_exists: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM messages WHERE id = $1 AND chat_id = $2",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if msg_exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "message not found".to_string()));
    }

    // Validate reason length.
    let reason = body.reason.trim().to_string();
    if reason.len() < 10 || reason.len() > 2000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "reason must be between 10 and 2000 characters".to_string(),
        ));
    }

    // Validate evidence length (if supplied).
    if let Some(ref ev) = body.evidence {
        if ev.len() > 5000 {
            return Err((
                StatusCode::BAD_REQUEST,
                "evidence must not exceed 5000 characters".to_string(),
            ));
        }
    }

    sqlx::query(
        "INSERT INTO reports (id, type, target_id, clan_id, reporter_id, reason, evidence) \
         VALUES (gen_random_uuid(), 'message', $1::text, $2, $3, $4, $5)",
    )
    .bind(message_id)
    .bind(chat.clan_id)
    .bind(auth.user_id)
    .bind(&reason)
    .bind(&body.evidence)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({"ok": true, "message": "report submitted"})),
    ))
}
