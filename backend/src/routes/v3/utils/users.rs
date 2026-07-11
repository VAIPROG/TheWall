//! User-reference resolution helpers shared by V3 routes.
//!
//! `resolve_user_ref` understands three forms:
//!   - `"me"`        → the authenticated user's own id
//!   - `"@username"` → explicit username lookup (the `@` is stripped)
//!   - UUID string   → direct id lookup
//!   - plain text    → username lookup (case-insensitive)

use axum::http::StatusCode;
use crate::http_error::ResultExt;
use uuid::Uuid;

/// Resolve a `user_ref` path segment to a user UUID.
///
/// Reserved values:
///   - `"me"` is always resolved to `caller_id`.
///   - Usernames may not start with `@` and may not equal `"me"`.
pub async fn resolve_user_ref(
    pool: &sqlx::PgPool,
    user_ref: &str,
    caller_id: Uuid,
) -> Result<Uuid, (StatusCode, String)> {
    let trimmed = user_ref.trim();
    if trimmed.eq_ignore_ascii_case("me") {
        return Ok(caller_id);
    }

    let lookup = trimmed.strip_prefix('@').unwrap_or(trimmed);
    if lookup.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "invalid user reference".to_string()));
    }

    if let Ok(uid) = Uuid::parse_str(lookup) {
        let exists: Option<bool> = sqlx::query_scalar("SELECT TRUE FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(pool)
            .await
            .or_500()?;
        if exists.is_some() {
            return Ok(uid);
        }
    }

    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE lower(username) = lower($1)",
    )
    .bind(lookup)
    .fetch_optional(pool)
    .await
    .or_500()?;

    row.map(|(id,)| id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))
}

/// Optional variant: returns `None` instead of 404 when the user is not found.
pub async fn resolve_user_ref_opt(
    pool: &sqlx::PgPool,
    user_ref: &str,
) -> Result<Option<Uuid>, (StatusCode, String)> {
    let lookup = user_ref.strip_prefix('@').unwrap_or(user_ref).trim();
    if lookup.eq_ignore_ascii_case("me") {
        // "me" only makes sense with a caller; in an optional context treat it as unresolved.
        return Ok(None);
    }

    if let Ok(uid) = Uuid::parse_str(lookup) {
        let exists: Option<bool> = sqlx::query_scalar("SELECT TRUE FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(pool)
            .await
            .or_500()?;
        if exists.is_some() {
            return Ok(Some(uid));
        }
    }

    sqlx::query_as::<_, (Uuid,)>("SELECT id FROM users WHERE lower(username) = lower($1)")
        .bind(lookup)
        .fetch_optional(pool)
        .await
        .or_500()
        .map(|opt| opt.map(|(id,)| id))
}

/// Check whether a username is syntactically valid for registration.
///
/// Rules:
///   - 1-32 characters
///   - may not be `"me"` (reserved path alias)
///   - may not start with `@`
///   - alphanumeric + underscore + hyphen + dot only
pub fn is_valid_username(username: &str) -> bool {
    let s = username.trim();
    let len = s.chars().count();
    if !(1..=32).contains(&len) {
        return false;
    }
    if s.eq_ignore_ascii_case("me") {
        return false;
    }
    if s.starts_with('@') {
        return false;
    }
    s.chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::is_valid_username;

    #[test]
    fn valid_username_basic() {
        assert!(is_valid_username("alice_42"));
        assert!(is_valid_username("bob-test.v2"));
    }

    #[test]
    fn reserved_me_is_invalid() {
        assert!(!is_valid_username("me"));
        assert!(!is_valid_username("ME"));
    }

    #[test]
    fn at_prefix_is_invalid() {
        assert!(!is_valid_username("@alice"));
    }

    #[test]
    fn empty_and_too_long_invalid() {
        assert!(!is_valid_username(""));
        assert!(!is_valid_username(&"a".repeat(33)));
    }

    #[test]
    fn invalid_chars_rejected() {
        assert!(!is_valid_username("alice space"));
        assert!(!is_valid_username("alice/"));
        assert!(!is_valid_username("alice🙂"));
    }
}
