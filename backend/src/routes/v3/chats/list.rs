//! GET /api/v3/chats — list all chats the caller participates in.

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, models::{ChatSummaryView, ChatV3}};

use super::resolve::{clan_chat_id, dm_key_for, global_chat_id};

// ---------------------------------------------------------------------------
// Row returned by the enrichment query
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ChatSummaryRow {
    id: Uuid,
    #[sqlx(rename = "type")]
    chat_type: String,
    clan_id: Option<Uuid>,
    dm_key: Option<String>,
    topic: Option<String>,
    slowmode_seconds: i32,
    created_at: DateTime<Utc>,
    unread_count: i64,
    last_message_at: Option<DateTime<Utc>>,
}

impl ChatSummaryRow {
    fn into_summary(self) -> ChatSummaryView {
        ChatSummaryView {
            id: self.id,
            chat_type: self.chat_type,
            clan_id: self.clan_id,
            dm_key: self.dm_key,
            topic: self.topic,
            slowmode_seconds: self.slowmode_seconds,
            created_at: self.created_at,
            unread_count: self.unread_count,
            last_message_at: self.last_message_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Helper — enrich a list of chat ids with unread counts + lastMessageAt
// ---------------------------------------------------------------------------

async fn enrich_chats(
    pool: &sqlx::PgPool,
    viewer: Uuid,
    chat_ids: &[Uuid],
) -> Result<Vec<ChatSummaryRow>, (StatusCode, String)> {
    if chat_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Single query: for each chat, compute lastMessageAt and unreadCount.
    //
    // unreadCount logic:
    //   - Exclude the caller's own messages and deleted messages.
    //   - If no chat_reads row exists, count all such messages.
    //   - If a read row exists, count messages with created_at > the
    //     created_at of last_read_message_id (via a sub-lookup).
    let rows = sqlx::query_as::<_, ChatSummaryRow>(
        "SELECT c.id,
                c.type,
                c.clan_id,
                c.dm_key,
                c.topic,
                c.slowmode_seconds,
                c.created_at,
                COALESCE((
                    SELECT MAX(m.created_at)
                    FROM messages m
                    WHERE m.chat_id = c.id
                      AND m.deleted_at IS NULL
                ), NULL) AS last_message_at,
                COALESCE((
                    SELECT COUNT(*)
                    FROM messages m
                    WHERE m.chat_id = c.id
                      AND m.deleted_at IS NULL
                      AND m.author_id != $1
                      AND (
                            -- No read row for this chat → count all unread non-own messages
                            NOT EXISTS (
                                SELECT 1 FROM chat_reads cr
                                WHERE cr.chat_id = c.id AND cr.account_id = $1
                            )
                          OR
                            -- Read row exists → only messages newer than the last-read one
                            m.created_at > COALESCE(
                                (SELECT rm.created_at
                                 FROM chat_reads cr
                                 JOIN messages rm ON rm.id = cr.last_read_message_id
                                 WHERE cr.chat_id = c.id AND cr.account_id = $1),
                                'epoch'::timestamptz
                            )
                      )
                ), 0) AS unread_count
         FROM chats c
         WHERE c.id = ANY($2)",
    )
    .bind(viewer)
    .bind(chat_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(rows)
}

// ---------------------------------------------------------------------------
// GET /api/v3/chats
// ---------------------------------------------------------------------------

pub async fn list_chats(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ChatSummaryView>>, (StatusCode, String)> {
    // Collect chat ids in display order (global, clan chats, DMs).
    let mut ordered_ids: Vec<Uuid> = Vec::new();

    // 1. Global chat (always present).
    let global_id = global_chat_id(&state.pool).await?;
    ordered_ids.push(global_id);

    // 2. Clan chats for each active clan membership (get-or-create).
    let clan_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT clan_id FROM clan_memberships WHERE user_id = $1 AND active = TRUE ORDER BY joined_at ASC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for clan_id in clan_ids {
        let chat_id = clan_chat_id(&state.pool, clan_id).await?;
        if !ordered_ids.contains(&chat_id) {
            ordered_ids.push(chat_id);
        }
    }

    // 3. DM chats where this user is a participant.
    let uid_str = auth.user_id.to_string();
    let dm_chats: Vec<ChatV3> = sqlx::query_as::<_, ChatV3>(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at \
         FROM chats \
         WHERE type = 'dm' \
           AND (dm_key LIKE $1 OR dm_key LIKE $2)",
    )
    .bind(format!("{}:%", uid_str))
    .bind(format!("%:{}", uid_str))
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for dm in &dm_chats {
        if let Some(ref key) = dm.dm_key {
            let parts: Vec<&str> = key.splitn(2, ':').collect();
            if parts.len() == 2 && (parts[0] == uid_str || parts[1] == uid_str) {
                if !ordered_ids.contains(&dm.id) {
                    ordered_ids.push(dm.id);
                }
            }
        }
    }

    // Suppress unused import warning for dm_key_for.
    let _ = dm_key_for;

    // 4. Enrich all chats in one query.
    let enriched = enrich_chats(&state.pool, auth.user_id, &ordered_ids).await?;

    // Re-order to match ordered_ids (the enrichment query may return rows in
    // arbitrary order because it uses ANY($2)).
    let mut map: std::collections::HashMap<Uuid, ChatSummaryRow> =
        enriched.into_iter().map(|r| (r.id, r)).collect();

    let summaries: Vec<ChatSummaryView> = ordered_ids
        .into_iter()
        .filter_map(|id| map.remove(&id).map(|r| r.into_summary()))
        .collect();

    Ok(Json(summaries))
}
