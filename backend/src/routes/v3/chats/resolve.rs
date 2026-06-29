//! Chat-resolution helpers and access-control predicate.

use axum::http::StatusCode;
use uuid::Uuid;

use crate::{models::ChatV3, routes::v3::utils::permissions};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Fetch the singleton global chat row.
pub async fn global_chat_id(pool: &sqlx::PgPool) -> Result<Uuid, (StatusCode, String)> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM chats WHERE type = 'global'")
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "global chat not seeded".to_string(),
            )
        })
}

/// Get-or-create the clan chat for `clan_id`.
pub async fn clan_chat_id(pool: &sqlx::PgPool, clan_id: Uuid) -> Result<Uuid, (StatusCode, String)> {
    // Try insert; if the unique index fires, the DO NOTHING path skips it.
    sqlx::query(
        "INSERT INTO chats (id, type, clan_id) \
         VALUES (gen_random_uuid(), 'clan', $1) \
         ON CONFLICT (clan_id) WHERE type = 'clan' DO NOTHING",
    )
    .bind(clan_id)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM chats WHERE type = 'clan' AND clan_id = $1",
    )
    .bind(clan_id)
    .fetch_one(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Get-or-create a DM chat for the pair `(a, b)`.
/// The `dm_key` is always `min(a,b):max(a,b)` so the pair is canonical.
pub async fn dm_chat_id(pool: &sqlx::PgPool, a: Uuid, b: Uuid) -> Result<Uuid, (StatusCode, String)> {
    let dm_key = dm_key_for(a, b);

    sqlx::query(
        "INSERT INTO chats (id, type, dm_key) \
         VALUES (gen_random_uuid(), 'dm', $1) \
         ON CONFLICT (dm_key) WHERE type = 'dm' DO NOTHING",
    )
    .bind(&dm_key)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM chats WHERE type = 'dm' AND dm_key = $1",
    )
    .bind(&dm_key)
    .fetch_one(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Get-or-create the global modmail thread for `opener`.
pub async fn modmail_chat_id(pool: &sqlx::PgPool, opener: Uuid) -> Result<Uuid, (StatusCode, String)> {
    sqlx::query(
        "INSERT INTO chats (id, type, opener_id) \
         VALUES (gen_random_uuid(), 'modmail', $1) \
         ON CONFLICT (opener_id) WHERE type = 'modmail' DO NOTHING",
    )
    .bind(opener)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM chats WHERE type = 'modmail' AND opener_id = $1",
    )
    .bind(opener)
    .fetch_one(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Resolve a userRef that is either a UUID or a case-insensitive username.
/// Returns `None` if the user does not exist.
pub async fn resolve_user_ref(pool: &sqlx::PgPool, user_ref: &str) -> Result<Option<Uuid>, (StatusCode, String)> {
    if let Ok(uid) = uuid::Uuid::parse_str(user_ref) {
        // UUID path: verify the row exists.
        let exists: Option<bool> = sqlx::query_scalar("SELECT TRUE FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        return Ok(exists.map(|_| uid));
    }
    // Username path: case-insensitive lookup.
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE LOWER(username) = LOWER($1)")
        .bind(user_ref)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Canonical dm_key: `min(a,b):max(a,b)`.
pub fn dm_key_for(a: Uuid, b: Uuid) -> String {
    if a < b {
        format!("{}:{}", a, b)
    } else {
        format!("{}:{}", b, a)
    }
}

/// Load a chat row by id, returning `None` if absent.
pub async fn load_chat(pool: &sqlx::PgPool, chat_id: Uuid) -> Result<Option<ChatV3>, (StatusCode, String)> {
    sqlx::query_as::<_, ChatV3>(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at, opener_id \
         FROM chats WHERE id = $1",
    )
    .bind(chat_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Return true iff `user_id` may access `chat`.
///
/// - global: any authenticated user.
/// - clan:   active member of the chat's clan.
/// - dm:     user_id is one of the two participants in dm_key.
/// - modmail: clan mod+ of the chat's clan (opener check deferred).
pub async fn can_access_chat(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    chat: &ChatV3,
) -> Result<bool, (StatusCode, String)> {
    match chat.chat_type.as_str() {
        "global" => Ok(true),
        "clan" => {
            let clan_id = match chat.clan_id {
                Some(c) => c,
                None => return Ok(false),
            };
            let member: Option<bool> = sqlx::query_scalar(
                "SELECT TRUE FROM clan_memberships \
                 WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
            )
            .bind(user_id)
            .bind(clan_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(member.is_some())
        }
        "dm" => {
            let key = match &chat.dm_key {
                Some(k) => k.clone(),
                None => return Ok(false),
            };
            // dm_key is "uuidA:uuidB" — check if user_id appears as either part.
            Ok(key.contains(&user_id.to_string()))
        }
        "modmail" => {
            // Opener sees their own thread.
            if chat.opener_id == Some(user_id) {
                return Ok(true);
            }
            // Global moderator/admin/owner sees all modmail threads.
            if permissions::global_role_of(pool, user_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .is_moderator()
            {
                return Ok(true);
            }
            // Clan-scoped modmail: allow that clan's mod+ as well.
            if let Some(clan_id) = chat.clan_id {
                if permissions::effective_clan_role(pool, user_id, clan_id)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                    .map(|r| r.is_moderator())
                    .unwrap_or(false)
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

