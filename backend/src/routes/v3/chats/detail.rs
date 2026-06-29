//! ChatDetail endpoints:
//!   GET /api/v3/chats/global          — global chat detail shortcut
//!   GET /api/v3/chats/{id}            — chat detail by id
//!   GET /api/v3/chats/{cid}/messages/{mid} — single message fetch

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{
        ChatDetailView, ChatViewerContext, LastMessagePreview, MessageJoinRow, MessageView,
        ParticipantView, ChatV3,
    },
    routes::v3::utils::permissions,
};

use super::reactions::{attach_reactions, attach_reactions_one};
use super::resolve::{can_access_chat, global_chat_id, load_chat};

// ---------------------------------------------------------------------------
// SQL column list (mirrors messages.rs to avoid cross-module coupling)
// ---------------------------------------------------------------------------

const MSG_COLS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

// ---------------------------------------------------------------------------
// Internal — build ChatDetailView from a loaded ChatV3
// ---------------------------------------------------------------------------

pub(super) async fn build_detail(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    chat: ChatV3,
) -> Result<ChatDetailView, (StatusCode, String)> {
    let chat_id = chat.id;

    // ── unread_count & last_message_at (reuse enrich logic inline) ──────────
    let (unread_count, last_message_at): (i64, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT
                COALESCE((
                    SELECT COUNT(*)
                    FROM messages m
                    WHERE m.chat_id = $1
                      AND m.deleted_at IS NULL
                      AND m.author_id != $2
                      AND (
                            NOT EXISTS (
                                SELECT 1 FROM chat_reads cr
                                WHERE cr.chat_id = $1 AND cr.account_id = $2
                            )
                          OR
                            m.created_at > COALESCE(
                                (SELECT rm.created_at
                                 FROM chat_reads cr
                                 JOIN messages rm ON rm.id = cr.last_read_message_id
                                 WHERE cr.chat_id = $1 AND cr.account_id = $2),
                                'epoch'::timestamptz
                            )
                      )
                ), 0),
                (
                    SELECT MAX(m.created_at)
                    FROM messages m
                    WHERE m.chat_id = $1
                      AND m.deleted_at IS NULL
                )",
        )
        .bind(chat_id)
        .bind(viewer_id)
        .fetch_one(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // ── viewer context ───────────────────────────────────────────────────────
    let can_post = can_access_chat(pool, viewer_id, &chat).await?;

    let viewer_role: Option<String> = match chat.chat_type.as_str() {
        "global" => {
            let g = permissions::global_role_of(pool, viewer_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Some(g.as_str().to_string())
        }
        "clan" | "modmail" => {
            if let Some(clan_id) = chat.clan_id {
                permissions::clan_role_of(pool, viewer_id, clan_id)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                    .map(|r| r.as_str().to_string())
            } else {
                None
            }
        }
        _ => None, // dm
    };

    let last_read_message_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT last_read_message_id FROM chat_reads WHERE chat_id = $1 AND account_id = $2",
    )
    .bind(chat_id)
    .bind(viewer_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .flatten();

    let viewer = ChatViewerContext {
        role: viewer_role,
        can_post,
        is_muted: false,
        last_read_message_id,
    };

    // ── participant_count & participants ─────────────────────────────────────
    let (participant_count, participants) = match chat.chat_type.as_str() {
        "global" => {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(pool)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            (count, Vec::new())
        }
        "dm" => {
            let dm_key = chat.dm_key.clone().unwrap_or_default();
            let parts: Vec<&str> = dm_key.splitn(2, ':').collect();
            let mut participants = Vec::new();
            for part in &parts {
                if let Ok(uid) = part.parse::<Uuid>() {
                    let row: Option<(Uuid, String)> =
                        sqlx::query_as("SELECT id, username FROM users WHERE id = $1")
                            .bind(uid)
                            .fetch_optional(pool)
                            .await
                            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                    if let Some((user_id, username)) = row {
                        participants.push(ParticipantView {
                            user_id,
                            username: username.clone(),
                            display_name: username,
                            avatar_url: None,
                            role: None,
                            role_rank: None,
                            last_read_message_id: None,
                            joined_at: None,
                            is_muted: false,
                        });
                    }
                }
            }
            (2i64, participants)
        }
        "clan" | "modmail" => {
            let clan_id = match chat.clan_id {
                Some(c) => c,
                None => return Err((StatusCode::INTERNAL_SERVER_ERROR, "clan_id missing".into())),
            };
            #[derive(sqlx::FromRow)]
            struct MemberRow {
                user_id: Uuid,
                username: String,
                clan_role: String,
                joined_at: chrono::DateTime<chrono::Utc>,
            }
            let members: Vec<MemberRow> = sqlx::query_as(
                "SELECT m.user_id, u.username, m.clan_role, m.joined_at \
                 FROM clan_memberships m \
                 JOIN users u ON u.id = m.user_id \
                 WHERE m.clan_id = $1 AND m.active = TRUE \
                 ORDER BY m.joined_at ASC",
            )
            .bind(clan_id)
            .fetch_all(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let count = members.len() as i64;
            let plist = members
                .into_iter()
                .map(|m| {
                    let role_rank = match m.clan_role.as_str() {
                        "admin" => 3,
                        "moderator" => 2,
                        _ => 1,
                    };
                    ParticipantView {
                        user_id: m.user_id,
                        username: m.username.clone(),
                        display_name: m.username,
                        avatar_url: None,
                        role: Some(m.clan_role),
                        role_rank: Some(role_rank),
                        last_read_message_id: None,
                        joined_at: Some(m.joined_at),
                        is_muted: false,
                    }
                })
                .collect();
            (count, plist)
        }
        _ => (0i64, Vec::new()),
    };

    // ── recent messages (latest 50, newest-first) ────────────────────────────
    let rows: Vec<MessageJoinRow> = sqlx::query_as(&format!(
        "SELECT {MSG_COLS} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.chat_id = $1 \
         ORDER BY m.created_at DESC \
         LIMIT 50"
    ))
    .bind(chat_id)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut recent_messages: Vec<MessageView> = rows.into_iter().map(|r| r.into_view()).collect();
    attach_reactions(pool, viewer_id, &mut recent_messages).await?;

    // ── last_message preview (newest non-deleted message) ────────────────────
    #[derive(sqlx::FromRow)]
    struct LastMsgRow {
        id: Uuid,
        author_username: Option<String>,
        content: String,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let last_message: Option<LastMessagePreview> = sqlx::query_as(
        "SELECT m.id, u.username AS author_username, m.content, m.created_at \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.chat_id = $1 AND m.deleted_at IS NULL \
         ORDER BY m.created_at DESC \
         LIMIT 1",
    )
    .bind(chat_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map(|r: LastMsgRow| {
        let preview: String = r.content.chars().take(120).collect();
        LastMessagePreview {
            id: r.id,
            author_username: r.author_username,
            content_preview: preview,
            created_at: r.created_at,
        }
    });

    Ok(ChatDetailView {
        id: chat.id,
        chat_type: chat.chat_type,
        clan_id: chat.clan_id,
        dm_key: chat.dm_key,
        topic: chat.topic,
        slowmode_seconds: chat.slowmode_seconds,
        created_at: chat.created_at,
        participant_count,
        unread_count,
        last_message_at,
        last_message,
        viewer,
        participants,
        recent_messages,
        pinned_message_ids: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// GET /api/v3/chats/{id}
// ---------------------------------------------------------------------------

pub async fn get_chat(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_id): Path<Uuid>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let detail = build_detail(&state.pool, auth.user_id, chat).await?;
    Ok(Json(detail))
}

// ---------------------------------------------------------------------------
// GET /api/v3/chats/global
// ---------------------------------------------------------------------------

pub async fn get_global_chat(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let chat_id = global_chat_id(&state.pool).await?;
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "global chat row missing".to_string()))?;

    let detail = build_detail(&state.pool, auth.user_id, chat).await?;
    Ok(Json(detail))
}

// ---------------------------------------------------------------------------
// GET /api/v3/chats/{cid}/messages/{mid}
// ---------------------------------------------------------------------------

pub async fn get_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<MessageView>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let row: Option<MessageJoinRow> = sqlx::query_as(&format!(
        "SELECT {MSG_COLS} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = $1 AND m.chat_id = $2"
    ))
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let row = row.ok_or_else(|| (StatusCode::NOT_FOUND, "message not found".to_string()))?;
    let mut view = row.into_view();
    attach_reactions_one(&state.pool, auth.user_id, &mut view).await?;
    Ok(Json(view))
}
