//! Access-control helpers derived from the the-wall-dev/2 document.
//!
//! The document JSONB carries the schema's access block. Per
//! `schema/theWallDev/2.json`:
//!   - usersWhitelist / usersBlocklist → BACKEND MUST ENFORCE (view)
//!   - allowedToEdit { userIds, clanIds } → BACKEND MUST ENFORCE (edit)
//!   - domainsWhitelist → CLIENT-SIDE only (not checked here)
//!
//! These functions are pure over `(user, clans, document)`; the owner and
//! global-admin overrides are applied by the callers, not here.
use serde_json::Value;
use uuid::Uuid;

/// UUIDs in a document string-array field (e.g. `usersWhitelist`).
fn uuid_array<'a>(doc: &'a Value, key: &str) -> impl Iterator<Item = Uuid> + 'a {
    doc.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .filter_map(|s| Uuid::parse_str(s).ok())
}

/// True if the user is explicitly blocked from viewing.
pub fn is_blocked(user: Uuid, doc: &Value) -> bool {
    uuid_array(doc, "usersBlocklist").any(|u| u == user)
}

/// True if the whitelist gate lets this user view. An empty/absent whitelist
/// means "no restriction" → everyone passes.
pub fn passes_whitelist(user: Uuid, doc: &Value) -> bool {
    let mut wl = uuid_array(doc, "usersWhitelist").peekable();
    if wl.peek().is_none() {
        return true;
    }
    wl.any(|u| u == user)
}

/// True if the user is a co-editor per `allowedToEdit` (by user id, or by
/// membership of an allowed clan). `user_clans` = the user's active clan ids.
pub fn is_editor(user: Uuid, user_clans: &[Uuid], doc: &Value) -> bool {
    let ate = match doc.get("allowedToEdit") {
        Some(v) => v,
        None => return false,
    };
    let by_user = ate
        .get("userIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .filter_map(|s| Uuid::parse_str(s).ok())
        .any(|u| u == user);
    if by_user {
        return true;
    }
    ate.get("clanIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .filter_map(|s| Uuid::parse_str(s).ok())
        .any(|c| user_clans.contains(&c))
}

/// Whole-document view gate for a NON-owner, NON-admin user: passes whitelist
/// AND not blocked. (Owner/admin/editor short-circuit in the caller.)
pub fn can_view(user: Uuid, doc: &Value) -> bool {
    !is_blocked(user, doc) && passes_whitelist(user, doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn u(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn empty_whitelist_allows_all() {
        assert!(passes_whitelist(u(1), &json!({})));
        assert!(passes_whitelist(u(1), &json!({ "usersWhitelist": [] })));
    }

    #[test]
    fn whitelist_restricts() {
        let doc = json!({ "usersWhitelist": [u(1).to_string()] });
        assert!(passes_whitelist(u(1), &doc));
        assert!(!passes_whitelist(u(2), &doc));
    }

    #[test]
    fn blocklist_blocks() {
        let doc = json!({ "usersBlocklist": [u(2).to_string()] });
        assert!(is_blocked(u(2), &doc));
        assert!(!is_blocked(u(1), &doc));
        assert!(!can_view(u(2), &doc));
        assert!(can_view(u(1), &doc));
    }

    #[test]
    fn editor_by_user_and_clan() {
        let doc = json!({ "allowedToEdit": { "userIds": [u(1).to_string()], "clanIds": [u(9).to_string()] } });
        assert!(is_editor(u(1), &[], &doc));
        assert!(!is_editor(u(2), &[], &doc));
        assert!(is_editor(u(2), &[u(9)], &doc));
        assert!(!is_editor(u(2), &[u(8)], &doc));
    }
}
