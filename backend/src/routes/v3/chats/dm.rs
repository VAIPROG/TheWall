//! DM thread handlers (replaces old open_dm):
//!   GET  /api/v3/dm/{user_ref}  — get-or-create DM thread with peer, return ChatDetailView
//!   POST /api/v3/dm/{user_ref}  — send a message into the DM thread with peer

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::{ChatDetailView, MessageView, SendMessageReq},
    routes::v3::utils::{chat_messages, sanctions, users::resolve_user_ref},
};

use super::detail::build_detail;
use super::reactions::attach_reactions_one;
use super::resolve::{dm_chat_id, load_chat};

// ---------------------------------------------------------------------------
// GET /api/v3/dm/{user_ref}
// ---------------------------------------------------------------------------

pub async fn get_dm_thread(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let peer = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    if peer == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot DM yourself".to_string()));
    }

    let chat_id = dm_chat_id(&state.pool, auth.user_id, peer).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "dm chat vanished".to_string()))?;

    let detail = build_detail(&state.pool, auth.user_id, chat).await?;
    Ok(Json(detail))
}

// ---------------------------------------------------------------------------
// POST /api/v3/dm/{user_ref}
// ---------------------------------------------------------------------------

pub async fn send_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let peer = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    if peer == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot DM yourself".to_string()));
    }

    let chat_id = dm_chat_id(&state.pool, auth.user_id, peer).await?;

    // Enforcement: mutes block chat messages.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::Mute, None)],
    )
    .await?;

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
