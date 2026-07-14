//! In-process cache of Discord guild ids a user has been server-verified to
//! OWN, populated by the clan-guilds OAuth callback and consumed (single-use)
//! by clan creation / ownership-verify. Mirrors `session_cache.rs`: a
//! `RwLock<HashMap>` with lazy TTL eviction. Consistent with never persisting
//! Discord tokens — this holds only derived guild ids and is lost on restart.

use chrono::{DateTime, Duration, Utc};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;
use uuid::Uuid;

/// How long a set of verified owned guilds stays usable after the OAuth round-trip.
const TTL_MINUTES: i64 = 10;

#[derive(Debug, Clone)]
struct Entry {
    guilds: HashSet<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct GuildCache {
    inner: RwLock<HashMap<Uuid, Entry>>,
}

impl GuildCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the user's verified owned-guild set (called from the callback).
    pub async fn put(&self, user_id: Uuid, guilds: HashSet<String>) {
        let entry = Entry {
            guilds,
            expires_at: Utc::now() + Duration::minutes(TTL_MINUTES),
        };
        self.inner.write().await.insert(user_id, entry);
    }

    /// The user's currently-valid verified owned-guild ids (empty if none/expired).
    pub async fn list(&self, user_id: Uuid) -> HashSet<String> {
        let map = self.inner.read().await;
        match map.get(&user_id) {
            Some(e) if e.expires_at > Utc::now() => e.guilds.clone(),
            _ => HashSet::new(),
        }
    }

    /// True iff `guild_id` is currently verified for `user_id`. Non-consuming.
    pub async fn contains(&self, user_id: Uuid, guild_id: &str) -> bool {
        self.list(user_id).await.contains(guild_id)
    }

    /// Verify-and-consume a single guild id: returns true and removes it (so a
    /// guild can back exactly one create/verify action). Returns false when
    /// absent or expired.
    pub async fn take(&self, user_id: Uuid, guild_id: &str) -> bool {
        let mut map = self.inner.write().await;
        match map.get_mut(&user_id) {
            Some(e) if e.expires_at > Utc::now() => e.guilds.remove(guild_id),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn put_then_contains_and_take_is_single_use() {
        let c = GuildCache::new();
        let u = Uuid::new_v4();
        c.put(u, set(&["111", "222"])).await;
        assert!(c.contains(u, "111").await);
        assert_eq!(c.list(u).await.len(), 2);
        assert!(c.take(u, "111").await, "first take succeeds");
        assert!(!c.take(u, "111").await, "second take fails (consumed)");
        assert!(c.contains(u, "222").await, "other guild still present");
    }

    #[tokio::test]
    async fn absent_guild_is_rejected() {
        let c = GuildCache::new();
        let u = Uuid::new_v4();
        c.put(u, set(&["111"])).await;
        assert!(!c.take(u, "999").await);
        assert!(!c.contains(u, "999").await);
    }

    #[tokio::test]
    async fn unknown_user_is_empty() {
        let c = GuildCache::new();
        assert!(c.list(Uuid::new_v4()).await.is_empty());
    }
}
