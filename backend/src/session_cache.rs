//! Lightweight in-memory session validity cache.
//!
//! V3 middleware verifies every Bearer token against the `sessions` table so
//! that logout / revocation takes effect immediately.  To avoid a database
//! query on every request we keep a small TTL cache of `(session_id,
//! token_hash) -> valid` results.  A negative result is also cached briefly.
//!
//! The cache is intentionally simple: `tokio::sync::RwLock` over a `HashMap`.
//! Eviction happens lazily on read and on explicit cleanup.  If this ever
//! becomes a bottleneck it can be replaced with `moka` without changing the
/// interface.

use chrono::{DateTime, Utc};
use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

/// How long a successful validation stays cached.
const HIT_TTL_SECONDS: i64 = 30;
/// How long a failed validation (revoked/expired token) stays cached.
const MISS_TTL_SECONDS: i64 = 5;
/// Maximum entries before we force a cleanup on insert.
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
struct CacheEntry {
    valid: bool,
    expires_at: DateTime<Utc>,
}

/// Thread-safe session validation cache.
#[derive(Debug, Default)]
pub struct SessionCache {
    inner: RwLock<HashMap<(Uuid, String), CacheEntry>>,
}

impl SessionCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up a cached validation result.  Returns `None` if there is no
    /// fresh entry.
    pub async fn get(&self,
        session_id: Uuid,
        token_hash: &str,
    ) -> Option<bool> {
        let key = (session_id, token_hash.to_string());
        let now = Utc::now();
        let map = self.inner.read().await;
        map.get(&key)
            .filter(|e| e.expires_at > now)
            .map(|e| e.valid)
    }

    /// Store a validation result.
    pub async fn set(&self,
        session_id: Uuid,
        token_hash: String,
        valid: bool,
    ) {
        let ttl = if valid {
            chrono::Duration::seconds(HIT_TTL_SECONDS)
        } else {
            chrono::Duration::seconds(MISS_TTL_SECONDS)
        };
        let entry = CacheEntry {
            valid,
            expires_at: Utc::now() + ttl,
        };

        let should_clean = {
            let mut map = self.inner.write().await;
            let key = (session_id, token_hash);
            map.insert(key, entry);
            map.len() > MAX_ENTRIES
        };

        if should_clean {
            self.cleanup().await;
        }
    }

    /// Remove stale entries.
    pub async fn cleanup(&self,
    ) {
        let now = Utc::now();
        let mut map = self.inner.write().await;
        map.retain(|_, entry| entry.expires_at > now);
    }
}
