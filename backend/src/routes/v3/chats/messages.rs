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
use crate::http_error::ResultExt;

use crate::{
    AppState,
    auth::AuthUser,
    models::{EditMessageReq, MessageJoinRow, MessageListQuery, MessageView, SendMessageReq},
    routes::v3::utils::{chat_messages, permissions, sanctions},
};

use super::reactions::{attach_reactions, attach_reactions_one};
use super::resolve::{can_access_chat, load_chat, resolve_chat_selector};

// ---------------------------------------------------------------------------
// GET /api/v3/chats/{chat_id}/messages
// ---------------------------------------------------------------------------

pub async fn list_messages(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_sel): Path<String>,
    Query(q): Query<MessageListQuery>,
) -> Result<Json<Vec<MessageView>>, (StatusCode, String)> {
    let chat_id = resolve_chat_selector(&state.pool, &chat_sel).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let limit = q.limit.unwrap_or(50).min(100);
    let cols = chat_messages::MESSAGE_COLUMNS;

    let rows: Vec<MessageJoinRow> = if let Some(before_id) = q.before {
        // Messages older than the cursor message.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {cols} \
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
        .or_500()?
    } else if let Some(after_id) = q.after {
        // Messages newer than the cursor message.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {cols} \
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
        .or_500()?
    } else {
        // Default: newest first.
        sqlx::query_as::<_, MessageJoinRow>(&format!(
            "SELECT {cols} \
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
        .or_500()?
    };

    let mut views: Vec<MessageView> = rows.into_iter().map(|r| r.into_view()).collect();
    attach_reactions(&state.pool, auth.user_id, &mut views).await?;
    Ok(Json(views))
}

// ---------------------------------------------------------------------------
// POST /api/v3/chats/{chat_id}/messages
// ---------------------------------------------------------------------------

pub async fn send_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_sel): Path<String>,
    Json(body): Json<SendMessageReq>,
) -> Result<(StatusCode, Json<MessageView>), (StatusCode, String)> {
    let chat_id = resolve_chat_selector(&state.pool, &chat_sel).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    // Enforcement: Mute blocks chat messages (modmail handled by send_modmail).
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::Mute, chat.clan_id)],
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
    .or_500()?
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

    let content = chat_messages::validate_message_content(
        &body.content,
        state.config.limits.message_chars,
    )?;
    let cols = chat_messages::MESSAGE_COLUMNS;

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
         SELECT {cols} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = (SELECT id FROM upd)"
    ))
    .bind(&content)
    .bind(message_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    let mut view = updated.into_view();
    attach_reactions_one(&state.pool, auth.user_id, &mut view).await?;
    Ok(Json(view))
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
    .or_500()?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "message not found".to_string()))?;

    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    // Gate on chat access first — prevents admins from deleting DM messages
    // in threads they are not a participant of.
    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".into()));
    }

    let is_author = msg_row.author_id == Some(auth.user_id);

    let allowed = if chat.chat_type == "dm" {
        // DM: only the message author may delete.
        is_author
    } else {
        // Non-DM: the author, or anyone with moderator authority over this chat.
        let can_moderate = if let Some(clan_id) = chat
            .clan_id
            .filter(|_| chat.chat_type == "clan" || chat.chat_type == "modmail")
        {
            // Clan-scoped: effective clan role already folds in global authority
            // (a global moderator counts as a clan moderator here).
            permissions::effective_clan_role(&state.pool, auth.user_id, clan_id)
                .await
                .or_500()?
                .map(|r| r.is_moderator())
                .unwrap_or(false)
        } else {
            // Global chat / global modmail: a global moderator+ moderates it.
            permissions::global_role_of(&state.pool, auth.user_id)
                .await
                .or_500()?
                .is_moderator()
        };

        is_author || can_moderate
    };

    if !allowed {
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
    .or_500()?;

    Ok(StatusCode::NO_CONTENT)
}
