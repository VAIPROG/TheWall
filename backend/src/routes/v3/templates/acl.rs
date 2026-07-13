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

/// Full SQL visibility condition for the `templates` table, parameterised by the
/// `$user_bind` placeholder (the caller's user id, bound as `Option<Uuid>`;
/// NULL = anonymous). Drop it into a WHERE as `AND ( <this> )`.
///
/// A user may VIEW a template when ANY of:
///   - they are the owner (`user_id`);
///   - they are a co-editor via `allowedToEdit.userIds`, or a member of a clan
///     in `allowedToEdit.clanIds`;
///   - the privacy gates pass: NOT in `usersBlocklist`, AND (a non-empty
///     `usersWhitelist` requires membership; otherwise the normal scope rules
///     apply — public+approved, or clan member for clan scope).
///
/// NULL or malformed documents degrade to "no privacy restrictions" (scope rules
/// only) — never a SQL error. UUIDs in the access arrays are JSON strings, hence
/// the `@> to_jsonb($u::text)` containment check.
pub fn view_sql(user_bind: usize, is_privileged: bool) -> String {
    if is_privileged {
        // Global moderators/admins/owners see every template regardless of
        // scope, whitelist, or blocklist — this is what makes staff immune to a
        // template's blocklist. The `${user_bind}` reference keeps the caller's
        // `.bind(user_id)` count valid while always evaluating TRUE.
        return format!("(${user_bind} IS NOT NULL OR TRUE)");
    }
    let u = format!("${user_bind}");
    // Raw string with real newlines: the newlines survive as whitespace in the
    // SQL, so tokens/placeholders stay separated. (A regular "\"-continued
    // string strips the next line's leading whitespace and would glue tokens
    // together, e.g. `$6OR`.)
    let scope_visible = format!(
        r#"((scope = 'public' AND status = 'approved')
            OR (scope = 'clan' AND clan_id IN (
                  SELECT clan_id FROM clan_memberships WHERE user_id = {u} AND active = TRUE)))"#
    );
    // Every `@> to_jsonb($u::text)` is guarded by `$u IS NOT NULL`: for an
    // anonymous caller `$u` is SQL NULL, and `array @> NULL` yields NULL (not
    // false), which would poison the COALESCE and spuriously deny anon on
    // templates carrying present-but-empty access arrays. An anon is simply
    // never a member of any list.
    format!(
        r#"COALESCE((
           user_id = {u}
           OR ({u} IS NOT NULL AND jsonb_typeof(document -> 'allowedToEdit' -> 'userIds') = 'array'
                 AND document -> 'allowedToEdit' -> 'userIds' @> to_jsonb(({u})::text))
           OR EXISTS (SELECT 1 FROM clan_memberships cm
                        WHERE cm.user_id = {u} AND cm.active = TRUE
                          AND jsonb_typeof(document -> 'allowedToEdit' -> 'clanIds') = 'array'
                          AND document -> 'allowedToEdit' -> 'clanIds' @> to_jsonb((cm.clan_id)::text))
           OR (
               (document -> 'usersBlocklist' IS NULL
                 OR jsonb_typeof(document -> 'usersBlocklist') <> 'array'
                 OR {u} IS NULL
                 OR NOT (document -> 'usersBlocklist' @> to_jsonb(({u})::text)))
               AND (
                 CASE WHEN jsonb_typeof(document -> 'usersWhitelist') = 'array'
                           AND jsonb_array_length(document -> 'usersWhitelist') > 0
                      THEN ({u} IS NOT NULL AND document -> 'usersWhitelist' @> to_jsonb(({u})::text))
                      ELSE {scope_visible}
                 END
               )
           )
        ), false)"#
    )
}

/// Whether a viewer is a global moderator/admin/owner — such staff see every
/// template regardless of scope/whitelist/blocklist (blocklist immunity).
/// Anonymous callers, or a role-lookup failure, yield `false`.
pub async fn is_privileged(pool: &sqlx::PgPool, user_id: Option<Uuid>) -> bool {
    match user_id {
        Some(uid) => crate::routes::v3::utils::permissions::global_role_of(pool, uid)
            .await
            .map(|r| r.is_moderator())
            .unwrap_or(false),
        None => false,
    }
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
