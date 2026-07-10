//! Shared helpers for V3 chat message routes.
//!
//! This module centralises column lists, message validation/insertion,
//! reply checking, and unread/last-message computation so that the
//! individual route files stay focused on HTTP semantics.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, models::MessageJoinRow};

/// Column list shared by every message SELECT that joins `users` for the
/// author's username.
pub const MESSAGE_COLUMNS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

/// Default maximum message length.  Callers can read `state.config.limits`
/// at runtime; this constant is the hard ceiling used when the config is
/// unavailable.
pub const MAX_MESSAGE_CHARS: usize = 4000;

/// Validate and normalise message content.
///
/// Returns `Ok(trimmed_content)` or a `(400, ...)` error.
pub fn validate_message_content(
    content: &str,
    max_chars: usize,
) -> Result<String, (axum::http::StatusCode, String)> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "content cannot be empty".to_string()));
    }
    if trimmed.chars().count() > max_chars {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("content must be ≤{max_chars} characters"),
        ));
    }
    Ok(trimmed.to_string())
}

/// Ensure that `reply_id` exists in `chat_id` and is not itself deleted.
pub async fn ensure_reply_in_chat(
    pool: &sqlx::PgPool,
    reply_id: Uuid,
    chat_id: Uuid,
) -> Result<(), (axum::http::StatusCode, String)> {
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL",
    )
    .bind(reply_id)
    .bind(chat_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if exists.is_none() {
        return Err((axum::http::StatusCode::BAD_REQUEST, "invalid reply_to_id".to_string()));
    }
    Ok(())
}

/// Insert a message into `messages` and return the joined row.
///
/// `author_id` is `Some(user_id)` for normal messages and `None` for system
/// messages (author_id is nullable in the schema).
pub async fn insert_message(
    pool: &sqlx::PgPool,
    chat_id: Uuid,
    author_id: Option<Uuid>,
    content: &str,
    reply_to_id: Option<Uuid>,
    is_system: bool,
) -> Result<MessageJoinRow, (axum::http::StatusCode, String)> {
    let row: MessageJoinRow = sqlx::query_as(&format!(
        r#"WITH inserted AS (
            INSERT INTO messages
                (id, chat_id, author_id, content, reply_to_id, is_system, version, created_at)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1, NOW())
            RETURNING id, chat_id, author_id, content, reply_to_id, edited_at, edit_count,
                      deleted_at, deleted_by, is_system, version, created_at
        )
        SELECT {MESSAGE_COLUMNS}
          FROM inserted m
          LEFT JOIN users u ON u.id = m.author_id"#
    ))
    .bind(chat_id)
    .bind(author_id)
    .bind(content)
    .bind(reply_to_id)
    .bind(is_system)
    .fetch_one(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(row)
}

/// Compute unread count + last message timestamp for a single chat.
pub async fn chat_unread_and_last_message(
    pool: &sqlx::PgPool,
    chat_id: Uuid,
    viewer_id: Uuid,
) -> Result<(i64, Option<DateTime<Utc>>), (axum::http::StatusCode, String)> {
    // The `chat_reads` row may exist with a NULL last_read_message_id, so decode
    // the column as `Option` (not bare `Uuid`) and flatten the no-row case.
    let last_read: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT last_read_message_id FROM chat_reads WHERE chat_id = $1 AND account_id = $2",
    )
    .bind(chat_id)
    .bind(viewer_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .flatten();

    let unread: Option<i64> = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM messages
            WHERE chat_id = $1
              AND author_id != $2
              AND deleted_at IS NULL
              AND ($3::uuid IS NULL OR created_at >
                   (SELECT created_at FROM messages WHERE id = $3))"#,
    )
    .bind(chat_id)
    .bind(viewer_id)
    .bind(last_read)
    .fetch_optional(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // `MAX(...)` always returns exactly one row whose value is NULL when the
    // chat has no messages (e.g. a freshly seeded global chat). Decode column 0
    // as `Option` and use `fetch_one`, otherwise sqlx tries to decode the NULL
    // into a bare `DateTime` and fails with "unexpected null".
    let last_at: Option<DateTime<Utc>> = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
        "SELECT MAX(created_at) FROM messages WHERE chat_id = $1 AND deleted_at IS NULL",
    )
    .bind(chat_id)
    .fetch_one(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((unread.unwrap_or(0), last_at))
}

/// Batch variant: unread count + last message timestamp for many chats.
///
/// Returns a map `chat_id -> (unread_count, last_message_at)`.
pub async fn batch_chat_unread_and_last_message(
    pool: &sqlx::PgPool,
    chat_ids: &[Uuid],
    viewer_id: Uuid,
) -> Result<std::collections::HashMap<Uuid, (i64, Option<DateTime<Utc>>)>, (axum::http::StatusCode, String)> {
    let mut map = std::collections::HashMap::<Uuid, (i64, Option<DateTime<Utc>>)>::new();
    if chat_ids.is_empty() {
        return Ok(map);
    }

    let rows: Vec<(Uuid, Option<i64>, Option<DateTime<Utc>>)> = sqlx::query_as(
        r#"SELECT
             c.id AS chat_id,
             (SELECT COUNT(*) FROM messages m
               WHERE m.chat_id = c.id
                 AND m.author_id != $1
                 AND m.deleted_at IS NULL
                 AND (rs.last_read_message_id IS NULL OR
                      m.created_at > (SELECT created_at FROM messages WHERE id = rs.last_read_message_id))),
             (SELECT MAX(created_at) FROM messages
               WHERE chat_id = c.id AND deleted_at IS NULL)
           FROM unnest($2::uuid[]) AS c(id)
           LEFT JOIN chat_reads rs
             ON rs.chat_id = c.id AND rs.account_id = $1"#,
    )
    .bind(viewer_id)
    .bind(chat_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for (chat_id, unread, last_at) in rows {
        map.insert(chat_id, (unread.unwrap_or(0), last_at));
    }
    Ok(map)
}

/// Authorisation helper: return a 403 if the caller cannot post in this chat.
pub async fn require_can_post(
    state: &AppState,
    auth: &AuthUser,
    chat_id: Uuid,
) -> Result<(), (axum::http::StatusCode, String)> {
    let chat = crate::routes::v3::chats::resolve::load_chat(&state.pool, chat_id,
    )
    .await?
    .ok_or((axum::http::StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    let can = crate::routes::v3::chats::resolve::can_access_chat(
        &state.pool, auth.user_id, &chat,
    )
    .await?;
    if !can {
        return Err((axum::http::StatusCode::FORBIDDEN, "cannot access chat".to_string()));
    }

    // Mute blocks posting but still allows modmail.
    let muted = crate::routes::v3::utils::sanctions::has_sanction(
        &state.pool,
        auth.user_id,
        &crate::routes::v3::utils::sanctions::Sanction::Mute,
        chat.clan_id,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if muted && chat.chat_type != "modmail" {
        return Err((axum::http::StatusCode::FORBIDDEN, "you are muted".to_string()));
    }

    Ok(())
}
