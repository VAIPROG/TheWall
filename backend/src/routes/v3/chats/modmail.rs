//! Modmail handlers:
//!   GET  /api/v3/chats/global/modmail  — get (or create) the caller's modmail thread
//!   POST /api/v3/chats/global/modmail  — send a message to the caller's modmail thread

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::{ChatDetailView, MessageJoinRow, MessageView, SendMessageReq},
    routes::v3::utils::sanctions,
};

use super::detail::build_detail;
use super::reactions::attach_reactions_one;
use super::resolve::{load_chat, modmail_chat_id};

const MSG_COLS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

// ---------------------------------------------------------------------------
// GET /api/v3/chats/global/modmail
// ---------------------------------------------------------------------------

pub async fn get_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let chat_id = modmail_chat_id(&state.pool, auth.user_id).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "modmail chat vanished".to_string()))?;

    let detail = build_detail(&state.pool, auth.user_id, chat).await?;
    Ok(Json(detail))
}

// ---------------------------------------------------------------------------
// POST /api/v3/chats/global/modmail
// ---------------------------------------------------------------------------

pub async fn send_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let chat_id = modmail_chat_id(&state.pool, auth.user_id).await?;

    // Enforcement: the separate SendModmail sanction controls modmail.
    // Mute intentionally does NOT block modmail so a muted user can still appeal.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::SendModmail, None)],
    )
    .await?;

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
