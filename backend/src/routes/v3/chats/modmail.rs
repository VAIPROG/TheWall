//! Modmail handlers:
//!   POST /api/v3/modmail            — send a message to global mods
//!   GET  /api/v3/modmail            — read the user's modmail thread
//!
//! Mute intentionally does NOT block modmail so a muted user can still appeal.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use crate::http_error::ResultExt;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ChatDetailView, MessageView, SendMessageReq},
    routes::v3::utils::chat_messages,
};

use super::detail::build_detail;
use super::reactions::attach_reactions_one;
use super::resolve::{modmail_chat_id, load_chat};

#[derive(Debug, Deserialize)]
pub struct ModmailQuery {
    /// When `true`, global moderators can read any user's modmail thread by
    /// passing the target account id.  Regular users omit this.
    pub user_id: Option<uuid::Uuid>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/modmail
// ---------------------------------------------------------------------------

pub async fn get_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ModmailQuery>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let opener = if let Some(target) = q.user_id {
        let role = crate::routes::v3::utils::permissions::global_role_of(
            &state.pool,
            auth.user_id,
        )
        .await
        .or_500()?;
        if !role.is_moderator() {
            return Err((StatusCode::FORBIDDEN, "moderator required".to_string()));
        }
        // Reading another user's modmail is a privileged action — record it.
        if target != auth.user_id {
            let _ = crate::routes::v3::utils::audit::log_action(
                &state.pool,
                auth.user_id,
                "modmail_viewed",
                "user",
                &target.to_string(),
                serde_json::json!({}),
            )
            .await;
        }
        target
    } else {
        auth.user_id
    };

    let chat_id = modmail_chat_id(&state.pool, opener).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "modmail chat vanished".to_string()))?;

    let detail = build_detail(&state.pool, auth.user_id, chat).await?;
    Ok(Json(detail))
}

// ---------------------------------------------------------------------------
// POST /api/v3/modmail
// ---------------------------------------------------------------------------

pub async fn send_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let chat_id = modmail_chat_id(&state.pool, auth.user_id).await?;

    let content = chat_messages::validate_message_content(
        &body.content,
        state.config.limits.message_chars,
    )?;

    if let Some(reply_id) = body.reply_to_id {
        chat_messages::ensure_reply_in_chat(&state.pool, reply_id, chat_id).await?;
    }

    let row = chat_messages::insert_message(
        &state.pool,
        chat_id,
        Some(auth.user_id),
        &content,
        body.reply_to_id,
        false,
    )
    .await?;

    let mut view = row.into_view();
    attach_reactions_one(&state.pool, auth.user_id, &mut view).await?;
    Ok((StatusCode::CREATED, Json(view)))
}
