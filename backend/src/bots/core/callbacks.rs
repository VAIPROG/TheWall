//! Owner-scoped, TTL callback store. Buttons carry a short random id (Discord
//! custom_id <=100, Telegram callback_data <=64); the real target lives here.
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use tokio::sync::RwLock;

const TTL_MINUTES: i64 = 30;

#[derive(Debug, Clone)]
pub struct CallbackSpec {
    pub command: String,
    pub sub: Option<String>,
    pub args: Vec<(String, String)>,   // simple string args to re-dispatch with
    pub owner_external_id: String,     // only this principal may click
}

struct Entry { spec: CallbackSpec, expires_at: DateTime<Utc> }

#[derive(Default)]
pub struct CallbackStore { inner: RwLock<HashMap<String, Entry>>, seq: std::sync::atomic::AtomicU64 }

impl CallbackStore {
    pub fn new() -> Self { Self::default() }

    /// Store a spec, return the short id to embed in the button.
    pub async fn put(&self, spec: CallbackSpec) -> String {
        let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // <=64 chars: "c" + hex counter + short owner suffix
        let id = format!("c{n:x}{}", &spec.owner_external_id.chars().take(8).collect::<String>());
        let id = id.chars().take(60).collect::<String>();
        self.inner.write().await.insert(id.clone(),
            Entry { spec, expires_at: Utc::now() + Duration::minutes(TTL_MINUTES) });
        id
    }

    /// Resolve a click. Returns the spec only if unexpired AND the clicker owns it.
    pub async fn take(&self, id: &str, clicker_external_id: &str) -> Option<CallbackSpec> {
        let mut map = self.inner.write().await;
        match map.get(id) {
            Some(e) if e.expires_at > Utc::now() && e.spec.owner_external_id == clicker_external_id => {
                Some(map.remove(id).unwrap().spec)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec(owner: &str) -> CallbackSpec {
        CallbackSpec { command: "roster".into(), sub: None, args: vec![("page".into(),"2".into())], owner_external_id: owner.into() }
    }
    #[tokio::test] async fn owner_scoped_single_use() {
        let s = CallbackStore::new();
        let id = s.put(spec("alice")).await;
        assert!(id.len() <= 64);
        assert!(s.take(&id, "bob").await.is_none(), "foreign clicker rejected");
        let got = s.take(&id, "alice").await.expect("owner resolves");
        assert_eq!(got.command, "roster");
        assert!(s.take(&id, "alice").await.is_none(), "single use");
    }
}
