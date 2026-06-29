//! Message CRUD handlers:
//!   GET    /api/v3/chats/{id}/messages
//!   POST   /api/v3/chats/{id}/messages
//!   PATCH  /api/v3/chats/{cid}/messages/{mid}
//!   DELETE /api/v3/chats/{cid}/messages/{mid}

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{EditMessageReq, MessageJoinRow, MessageListQuery, MessageView, SendMessageReq},
    routes::v2::permissions,
};

use super::resolve::{can_access_chat, load_chat};

// ---------------------------------------------------------------------------
// SQL column list shared by all message queries
// ---------------------------------------------------------------------------

const MSG_COLS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

// ---------------------------------------------------------------------------
// GET /api/v3/chats/{chat_id}/messages
// ---------------------------------------------------------------------------

pub async fn list_messages(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_id): Path<Uuid>,
    Query(q): Query<MessageListQuery>,
) -> Result<Json<Vec<MessageView>>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let limit = q.limit.unwrap_or(50).min(100);

    let rows: Vec<MessageJoinRow> = if let Some(before_id) = q.before {
        // Messages older than the cursor message.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {MSG_COLS} \
             FROM messages m \
             LEFT JOIN users u ON u.id = m.author_id \
             WHERE m.chat_id = $1 \
               AND m.created_at < (SELECT created_at FROM messages WHERE id = $2 AND chat_id = $1) \
             ORDER BY m.created_at DESC \
             LIMIT $3"
        ))
        .bind(chat_id)
        .bind(before_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else if let Some(after_id) = q.after {
        // Messages newer than the cursor message.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {MSG_COLS} \
             FROM messages m \
             LEFT JOIN users u ON u.id = m.author_id \
             WHERE m.chat_id = $1 \
               AND m.created_at > (SELECT created_at FROM messages WHERE id = $2 AND chat_id = $1) \
             ORDER BY m.created_at DESC \
             LIMIT $3"
        ))
        .bind(chat_id)
        .bind(after_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        // Default: newest first.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {MSG_COLS} \
             FROM messages m \
             LEFT JOIN users u ON u.id = m.author_id \
             WHERE m.chat_id = $1 \
             ORDER BY m.created_at DESC \
             LIMIT $2"
        ))
        .bind(chat_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    Ok(Json(rows.into_iter().map(|r| r.into_view()).collect()))
}

// ---------------------------------------------------------------------------
// POST /api/v3/chats/{chat_id}/messages
// ---------------------------------------------------------------------------

pub async fn send_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_id): Path<Uuid>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

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

    Ok((StatusCode::CREATED, Json(row.into_view())))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/chats/{chat_id}/messages/{message_id}
// ---------------------------------------------------------------------------

pub async fn edit_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<EditMessageReq>,
) -> Result<Json<MessageView>, (StatusCode, String)> {
    // Load the message (must belong to this chat).
    let msg_row = sqlx::query_as::<_, crate::models::MessageV3>(
        "SELECT id, chat_id, author_id, content, reply_to_id, \
                edited_at, edit_count, deleted_at, deleted_by, \
                is_system, version, created_at \
         FROM messages WHERE id = $1 AND chat_id = $2",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "message not found".to_string()))?;

    // AUTHOR-ONLY: no other role may edit.
    if msg_row.author_id != Some(auth.user_id) {
        return Err((
            StatusCode::FORBIDDEN,
            "you can only edit your own messages".to_string(),
        ));
    }

    // Cannot edit a deleted message.
    if msg_row.deleted_at.is_some() {
        return Err((StatusCode::CONFLICT, "message deleted".to_string()));
    }

    // Optimistic concurrency check.
    if let Some(ev) = body.expected_version {
        if ev != msg_row.version {
            return Err((StatusCode::CONFLICT, "version conflict".to_string()));
        }
    }

    let content = body.content.trim().to_string();
    if content.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "content cannot be empty".to_string()));
    }
    if content.len() > 4000 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "content exceeds 4000 chars".to_string()));
    }

    let updated = sqlx::query_as::<_, MessageJoinRow>(&format!(
        "WITH upd AS ( \
             UPDATE messages \
             SET content = $1, edited_at = NOW(), \
                 edit_count = edit_count + 1, version = version + 1 \
             WHERE id = $2 \
             RETURNING id, chat_id, author_id, content, reply_to_id, \
                       edited_at, edit_count, deleted_at, deleted_by, \
                       is_system, version, created_at \
         ) \
         SELECT {MSG_COLS} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = (SELECT id FROM upd)"
    ))
    .bind(&content)
    .bind(message_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(updated.into_view()))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/chats/{chat_id}/messages/{message_id}
// ---------------------------------------------------------------------------

pub async fn delete_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Load message + its chat.
    let msg_row = sqlx::query_as::<_, crate::models::MessageV3>(
        "SELECT id, chat_id, author_id, content, reply_to_id, \
                edited_at, edit_count, deleted_at, deleted_by, \
                is_system, version, created_at \
         FROM messages WHERE id = $1 AND chat_id = $2",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "message not found".to_string()))?;

    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    // Authorization: author OR global admin/owner OR clan mod+ in a clan chat.
    let is_author = msg_row.author_id == Some(auth.user_id);

    let is_global_admin = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_admin();

    let is_clan_mod = if chat.chat_type == "clan" {
        if let Some(clan_id) = chat.clan_id {
            permissions::effective_clan_role(&state.pool, auth.user_id, clan_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .map(|r| r.is_mod())
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    if !is_author && !is_global_admin && !is_clan_mod {
        return Err((StatusCode::FORBIDDEN, "not allowed".to_string()));
    }

    // Soft-delete (idempotent).
    sqlx::query(
        "UPDATE messages \
         SET deleted_at = NOW(), deleted_by = $1, version = version + 1 \
         WHERE id = $2 AND deleted_at IS NULL",
    )
    .bind(auth.user_id)
    .bind(message_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}
