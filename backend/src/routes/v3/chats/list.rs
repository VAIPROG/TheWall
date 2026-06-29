//! GET /api/v3/chats — list all chats the caller participates in.

use axum::{Json, extract::State, http::StatusCode};

use crate::{AppState, auth::AuthUser, models::ChatV3};

use super::resolve::{clan_chat_id, dm_key_for, global_chat_id};

pub async fn list_chats(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ChatV3>>, (StatusCode, String)> {
    let mut chats: Vec<ChatV3> = Vec::new();

    // 1. Global chat (always present).
    let global_id = global_chat_id(&state.pool).await?;
    let global = sqlx::query_as::<_, ChatV3>(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at \
         FROM chats WHERE id = $1",
    )
    .bind(global_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    chats.push(global);

    // 2. Clan chats for each active clan membership (get-or-create).
    let clan_ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT clan_id FROM clan_memberships WHERE user_id = $1 AND active = TRUE ORDER BY joined_at ASC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for clan_id in clan_ids {
        let chat_id = clan_chat_id(&state.pool, clan_id).await?;
        let chat = sqlx::query_as::<_, ChatV3>(
            "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at \
             FROM chats WHERE id = $1",
        )
        .bind(chat_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        chats.push(chat);
    }

    // 3. DM chats where this user is a participant.
    //    dm_key is "uuidA:uuidB" — we look for rows where either half matches.
    let uid_str = auth.user_id.to_string();
    // Use LIKE with the sorted key prefix/suffix patterns.
    // The key is always "small:large". The user appears as either the first or second segment.
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

    // Deduplicate (a dm_key could theoretically match both LIKE patterns if
    // somehow a UUID contains ":" — impossible in practice, but be safe).
    for dm in dm_chats {
        // Only add if the dm_key genuinely contains this user as one of the two halves.
        if let Some(ref key) = dm.dm_key {
            let parts: Vec<&str> = key.splitn(2, ':').collect();
            if parts.len() == 2 && (parts[0] == uid_str || parts[1] == uid_str) {
                // Avoid duplicate if somehow already in chats (shouldn't happen).
                if !chats.iter().any(|c| c.id == dm.id) {
                    chats.push(dm);
                }
            }
        }
    }

    // Suppress unused warning for dm_key_for helper imported from resolve.
    let _ = dm_key_for;

    Ok(Json(chats))
}
