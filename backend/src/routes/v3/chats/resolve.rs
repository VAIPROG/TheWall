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

/// Resolve a chat path selector to a concrete chat id.
///
/// The `{id}` segment on the chat/message routes accepts either the literal
/// keyword `global` (the singleton global chat) or a chat UUID. Clan and DM
/// chats have their own dedicated routes, so those keywords are not handled
/// here. Without this, a request to `/api/v3/chats/global/messages` tried to
/// parse `global` as a UUID and failed with a 400.
pub async fn resolve_chat_selector(
    pool: &sqlx::PgPool,
    selector: &str,
) -> Result<Uuid, (StatusCode, String)> {
    if selector.eq_ignore_ascii_case("global") {
        return global_chat_id(pool).await;
    }
    Uuid::parse_str(selector)
        .map_err(|_| (StatusCode::BAD_REQUEST, format!("invalid chat id: {selector}")))
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

/// Canonical dm_key: `min(a,b):max(a,b)`.
pub fn dm_key_for(a: Uuid, b: Uuid) -> String {
    if a < b {
        format!("{}:{}", a, b)
    } else {
        format!("{}:{}", b, a)
    }
}

/// Parse a DM key into its two participant UUIDs.
pub fn parse_dm_key(dm_key: &str) -> Option<(Uuid, Uuid)> {
    let mut parts = dm_key.split(':');
    let a = parts.next().and_then(|p| Uuid::parse_str(p).ok())?;
    let b = parts.next().and_then(|p| Uuid::parse_str(p).ok())?;
    if parts.next().is_some() {
        return None;
    }
    Some((a, b))
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
/// - modmail: opener or global/clan moderator+.
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
                Some(k) => k,
                None => return Ok(false),
            };
            match parse_dm_key(key) {
                Some((a, b)) => Ok(a == user_id || b == user_id),
                None => Ok(false),
            }
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

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{dm_key_for, parse_dm_key};
    use uuid::Uuid;

    #[test]
    fn dm_key_is_sorted() {
        let a = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let b = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let key = dm_key_for(a, b);
        assert!(key.starts_with(&a.to_string()));
        assert!(key.ends_with(&b.to_string()));
        assert_eq!(dm_key_for(a, b), dm_key_for(b, a));
    }

    #[test]
    fn parse_dm_key_round_trip() {
        let a = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let b = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let key = dm_key_for(a, b);
        let parsed = parse_dm_key(&key).unwrap();
        assert_eq!(parsed, (a, b));
    }

    #[test]
    fn parse_dm_key_rejects_invalid() {
        assert!(parse_dm_key("not-a-uuid:also-not").is_none());
        assert!(parse_dm_key("too:many:colons").is_none());
        assert!(parse_dm_key("").is_none());
    }

    #[test]
    fn parse_dm_key_preserves_canonical_order() {
        let a = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let b = Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap();
        let key = dm_key_for(a, b);
        let parsed = parse_dm_key(&key).unwrap();
        assert_eq!(parsed.0, a);
        assert_eq!(parsed.1, b);
    }
}
