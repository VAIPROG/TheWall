//! Pin / unpin messages in a chat.
//!
//!   POST   /api/v3/chats/{cid}/messages/{mid}/pin
//!   DELETE /api/v3/chats/{cid}/messages/{mid}/pin
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    routes::v3::{
        chats::resolve::{can_access_chat, load_chat},
        utils::{audit, permissions::effective_clan_role},
    },
};

async fn can_moderate_chat(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    chat: &crate::models::ChatV3,
) -> Result<bool, (StatusCode, String)> {
    // Global chat / modmail: global moderator+
    let global_ok = if chat.chat_type == "global" || chat.chat_type == "modmail" {
        crate::routes::v3::utils::permissions::global_role_of(pool, user_id)
            .await
            .or_500()?
            .is_moderator()
    } else {
        false
    };

    // Clan chat: clan moderator+ (folds in global mods via effective_clan_role).
    let clan_ok = if let Some(cid) = chat.clan_id {
        effective_clan_role(pool, user_id, cid)
            .await
            .or_500()?
            .map(|r| r.is_moderator())
            .unwrap_or(false)
    } else {
        false
    };

    Ok(global_ok || clan_ok)
}

async fn message_exists_in_chat(
    pool: &sqlx::PgPool,
    chat_id: Uuid,
    message_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL)",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

pub async fn pin_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    if !can_moderate_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "moderator required".to_string()));
    }

    if !message_exists_in_chat(&state.pool, chat_id, message_id).await.or_500()? {
        return Err((StatusCode::NOT_FOUND, "message not found".to_string()));
    }

    sqlx::query(
        r#"INSERT INTO pinned_messages (chat_id, message_id, pinned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (chat_id, message_id) DO UPDATE SET pinned_at = NOW()"#,
    )
    .bind(chat_id)
    .bind(message_id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "message_pinned",
        "message",
        &message_id.to_string(),
        json!({ "chatId": chat_id }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "pinned"})))
}

pub async fn unpin_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    if !can_moderate_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "moderator required".to_string()));
    }

    let result = sqlx::query(
        "DELETE FROM pinned_messages WHERE chat_id = $1 AND message_id = $2",
    )
    .bind(chat_id)
    .bind(message_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "message not pinned".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "message_unpinned",
        "message",
        &message_id.to_string(),
        json!({ "chatId": chat_id }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "unpinned"})))
}
