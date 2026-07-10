//! Chat detail handler:
//!   GET /api/v3/chats/{id} — full chat context + participants + recent messages

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
        ChatDetailView, ChatV3, LastMessagePreview, MessageJoinRow, MessageView, ParticipantView,
    },
    routes::v3::utils::{chat_messages, permissions},
};

use super::reactions::attach_reactions;
use super::resolve::{can_access_chat, load_chat, resolve_chat_selector};

// ---------------------------------------------------------------------------
// GET /api/v3/chats/{chat_id}
// ---------------------------------------------------------------------------

pub async fn get_chat_detail(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_sel): Path<String>,
) -> Result<Json<ChatDetailView>, (StatusCode, String)> {
    let chat_id = resolve_chat_selector(&state.pool, &chat_sel).await?;
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
// Shared detail builder
// ---------------------------------------------------------------------------

pub async fn build_detail(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    chat: ChatV3,
) -> Result<ChatDetailView, (StatusCode, String)> {
    let cols = chat_messages::MESSAGE_COLUMNS;

    // Unread count + last message timestamp for this chat.
    let (unread_count, last_message_at) =
        chat_messages::chat_unread_and_last_message(pool, chat.id, viewer_id).await?;

    // Latest message preview.
    let last_message: Option<LastMessagePreview> = if let Some(_ts) = last_message_at {
        sqlx::query_as(&format!(
            "SELECT {cols} \
             FROM messages m \
             LEFT JOIN users u ON u.id = m.author_id \
             WHERE m.chat_id = $1 AND m.deleted_at IS NULL \
             ORDER BY m.created_at DESC \
             LIMIT 1"
        ))
        .bind(chat.id)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(|row: MessageJoinRow| {
            let preview_text: String = row.content.chars().take(120).collect();
            LastMessagePreview {
                id: row.id,
                author_username: row.author_username,
                content_preview: preview_text,
                created_at: row.created_at,
            }
        })
    } else {
        None
    };

    // Recent messages (newest 50).
    let mut recent_messages: Vec<MessageView> = sqlx::query_as::<_, MessageJoinRow>(
        &format!(
            "SELECT {cols} \
             FROM messages m \
             LEFT JOIN users u ON u.id = m.author_id \
             WHERE m.chat_id = $1 \
             ORDER BY m.created_at DESC \
             LIMIT $2"
        ),
    )
    .bind(chat.id)
    .bind(50i64)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .into_iter()
    .map(|r| r.into_view())
    .collect();
    recent_messages.reverse();
    attach_reactions(pool, viewer_id, &mut recent_messages).await?;

    // Participants + viewer context.
    let (participants, viewer) = build_participants_and_viewer(pool, viewer_id, &chat).await?;

    // Pinned message ids.
    let pinned_message_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT message_id FROM pinned_messages WHERE chat_id = $1 ORDER BY pinned_at DESC",
    )
    .bind(chat.id)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let participant_count = participants.len() as i64;

    Ok(ChatDetailView {
        id: chat.id,
        chat_type: chat.chat_type.clone(),
        clan_id: chat.clan_id,
        dm_key: chat.dm_key.clone(),
        topic: chat.topic.clone(),
        slowmode_seconds: chat.slowmode_seconds,
        created_at: chat.created_at,
        participant_count,
        unread_count,
        last_message_at,
        last_message,
        viewer,
        participants,
        recent_messages,
        pinned_message_ids,
    })
}

async fn build_participants_and_viewer(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    chat: &ChatV3,
) -> Result<(Vec<ParticipantView>, crate::models::ChatViewerContext), (StatusCode, String)> {
    use crate::models::ChatViewerContext;

    match chat.chat_type.as_str() {
        "dm" => {
            let (a, b) = match chat.dm_key.as_deref().and_then(super::resolve::parse_dm_key) {
                Some(pair) => pair,
                None => return Ok((Vec::new(), ChatViewerContext {
                    role: None,
                    can_post: false,
                    is_muted: false,
                    last_read_message_id: None,
                })),
            };

            let ids = vec![a, b];
            let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, Option<String>)>(
                "SELECT u.id, u.username, u.display_name, a.image \
                 FROM users u LEFT JOIN avatars a ON a.user_id = u.id \
                 WHERE u.id = ANY($1)",
            )
            .bind(&ids)
            .fetch_all(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let mut participants = Vec::new();
            for (uid, username, display_name, avatar_url) in rows {
                let last_read: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
                    "SELECT last_read_message_id FROM chat_reads \
                     WHERE chat_id = $1 AND account_id = $2",
                )
                .bind(chat.id)
                .bind(uid)
                .fetch_optional(pool)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .flatten();

                participants.push(ParticipantView {
                    user_id: uid,
                    username,
                    display_name: display_name.unwrap_or_default(),
                    avatar_url,
                    role: None,
                    role_rank: None,
                    last_read_message_id: last_read,
                    joined_at: None,
                    is_muted: false,
                });
            }

            let viewer_last_read: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT last_read_message_id FROM chat_reads \
                 WHERE chat_id = $1 AND account_id = $2",
            )
            .bind(chat.id)
            .bind(viewer_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .flatten();

            let viewer = ChatViewerContext {
                role: None,
                can_post: true,
                is_muted: false,
                last_read_message_id: viewer_last_read,
            };
            Ok((participants, viewer))
        }
        "modmail" => {
            // Modmail participants are the opener and global moderators+.
            let mut participants = Vec::new();

            let opener_id = chat.opener_id.unwrap_or(viewer_id);
            if let Some(opener_row) = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
                "SELECT u.username, u.display_name, a.image FROM users u \
                 LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = $1",
            )
            .bind(opener_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            {
                let (username, display_name, avatar_url) = opener_row;
                participants.push(ParticipantView {
                    user_id: opener_id,
                    username,
                    display_name: display_name.unwrap_or_default(),
                    avatar_url,
                    role: Some("opener".to_string()),
                    role_rank: Some(0),
                    last_read_message_id: None,
                    joined_at: None,
                    is_muted: false,
                });
            }

            // Add global moderators+ as participants.
            let mod_rows: Vec<(Uuid, String, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT u.id, u.username, u.display_name, a.image \
                 FROM users u LEFT JOIN avatars a ON a.user_id = u.id \
                 WHERE u.global_role IN ('moderator','admin','owner')",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            for (uid, username, display_name, avatar_url) in mod_rows {
                if uid == opener_id {
                    continue;
                }
                participants.push(ParticipantView {
                    user_id: uid,
                    username,
                    display_name: display_name.unwrap_or_default(),
                    avatar_url,
                    role: Some("moderator".to_string()),
                    role_rank: Some(1),
                    last_read_message_id: None,
                    joined_at: None,
                    is_muted: false,
                });
            }

            let is_mod = permissions::global_role_of(pool, viewer_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .is_moderator();

            let viewer = ChatViewerContext {
                role: if is_mod { Some("moderator".to_string()) } else { Some("opener".to_string()) },
                can_post: true,
                is_muted: false,
                last_read_message_id: None,
            };

            Ok((participants, viewer))
        }
        _ => {
            // Global / clan chat: pull from clan_memberships when clan-scoped.
            let rows: Vec<(
                Uuid,
                String,
                Option<String>,
                Option<String>,
                String,
                i32,
                Option<Uuid>,
                chrono::DateTime<chrono::Utc>,
            )> = if let Some(clan_id) = chat.clan_id {
                sqlx::query_as(
                    "SELECT u.id, u.username, u.display_name, av.image, \
                            m.clan_role, r.rank, rs.last_read_message_id, m.joined_at \
                     FROM clan_memberships m \
                     JOIN users u ON u.id = m.user_id \
                     LEFT JOIN avatars av ON av.user_id = u.id \
                     LEFT JOIN clan_roles r ON r.clan_id = m.clan_id AND r.role = m.clan_role \
                     LEFT JOIN chat_reads rs ON rs.chat_id = $1 AND rs.account_id = u.id \
                     WHERE m.clan_id = $2 AND m.active = TRUE \
                     ORDER BY r.rank DESC NULLS LAST, m.joined_at",
                )
                .bind(chat.id)
                .bind(clan_id)
                .fetch_all(pool)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            } else {
                // Global chat: no participant list.
                Vec::new()
            };

            let participants: Vec<ParticipantView> = rows
                .into_iter()
                .map(|(uid, username, display_name, avatar_url, role, rank, last_read, joined_at)| {
                    ParticipantView {
                        user_id: uid,
                        username,
                        display_name: display_name.unwrap_or_default(),
                        avatar_url,
                        role: Some(role),
                        role_rank: Some(rank),
                        last_read_message_id: last_read,
                        joined_at: Some(joined_at),
                        is_muted: false,
                    }
                })
                .collect();

            let (can_post, is_muted, role) = if let Some(clan_id) = chat.clan_id {
                let effective = permissions::effective_clan_role(pool, viewer_id, clan_id)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let can_post = effective.is_some();
                let is_muted = crate::routes::v3::utils::sanctions::has_sanction(
                    pool,
                    viewer_id,
                    &crate::routes::v3::utils::sanctions::Sanction::Mute,
                    Some(clan_id),
                )
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                (can_post, is_muted, effective.map(|r| r.as_str().to_string()))
            } else {
                let is_muted = crate::routes::v3::utils::sanctions::has_sanction(
                    pool,
                    viewer_id,
                    &crate::routes::v3::utils::sanctions::Sanction::Mute,
                    None,
                )
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                (true, is_muted, None)
            };

            let viewer_last_read: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT last_read_message_id FROM chat_reads \
                 WHERE chat_id = $1 AND account_id = $2",
            )
            .bind(chat.id)
            .bind(viewer_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .flatten();

            let viewer = ChatViewerContext {
                role,
                can_post,
                is_muted,
                last_read_message_id: viewer_last_read,
            };

            Ok((participants, viewer))
        }
    }
}
