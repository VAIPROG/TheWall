//! DM thread handlers (replaces old open_dm):
//!   GET  /api/v3/chats/dm/{user_ref}  — get-or-create DM thread with peer, return ChatDetailView
//!   POST /api/v3/chats/dm/{user_ref}  — send a message into the DM thread with peer

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::{ChatDetailView, MessageJoinRow, MessageView, SendMessageReq},
};

use super::detail::build_detail;
use super::reactions::attach_reactions_one;
use super::resolve::{dm_chat_id, load_chat, resolve_user_ref};

const MSG_COLS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

// ---------------------------------------------------------------------------
// GET /api/v3/chats/dm/{user_ref}
// ---------------------------------------------------------------------------

pub async fn get_dm_thread(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let peer = resolve_user_ref(&state.pool, &user_ref)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

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
// POST /api/v3/chats/dm/{user_ref}
// ---------------------------------------------------------------------------

pub async fn send_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let peer = resolve_user_ref(&state.pool, &user_ref)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    if peer == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot DM yourself".to_string()));
    }

    let chat_id = dm_chat_id(&state.pool, auth.user_id, peer).await?;

    let content = body.content.trim().to_string();
    if content.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "content cannot be empty".to_string()));
    }
    if content.len() > 4000 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "content exceeds 4000 chars".to_string()));
    }

    // Validate reply_to belongs to the same chat.
    if let Some(reply_id) = body.reply_to_id {
        let exists: Option<bool> = sqlx::query_scalar(
            "SELECT TRUE FROM messages WHERE id = $1 AND chat_id = $2",
        )
        .bind(reply_id)
        .bind(chat_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if exists.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "reply_to_id does not exist in this chat".to_string(),
            ));
        }
    }

    let row = sqlx::query_as::<_, MessageJoinRow>(&format!(
        "WITH inserted AS ( \
             INSERT INTO messages (id, chat_id, author_id, content, reply_to_id) \
             VALUES (gen_random_uuid(), $1, $2, $3, $4) \
             RETURNING id, chat_id, author_id, content, reply_to_id, \
                       edited_at, edit_count, deleted_at, deleted_by, \
                       is_system, version, created_at \
         ) \
         SELECT {MSG_COLS} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = (SELECT id FROM inserted)"
    ))
    .bind(chat_id)
    .bind(auth.user_id)
    .bind(&content)
    .bind(body.reply_to_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut view = row.into_view();
    attach_reactions_one(&state.pool, auth.user_id, &mut view).await?;
    Ok((StatusCode::CREATED, Json(view)))
}
