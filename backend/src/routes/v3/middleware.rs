//! V3 request middleware — authentication + global-ban gate.
//!
//! A single layer is applied to the whole `/api/v3` router. It:
//!   1. Verifies the `Authorization: Bearer <jwt>` header if present and stores
//!      the resulting `AuthUser` in request extensions so handlers (and the
//!      `AuthUser` extractor) can reuse it without re-decoding the JWT.
//!   2. Validates the access token against the `sessions` table (with an
//!      in-memory TTL cache) so logout and revocation take effect immediately.
//!   3. If the caller is authenticated, checks whether the user is globally
//!      banned. Banned users may still reach a short allow-list of routes
//!      (public read endpoints, auth/session management, `/me/appeal`, and
//!      `/me/restrictions`).
//!
//! Public routes that do not use `AuthUser` naturally pass through when no
//! `Authorization` header is sent.

use axum::{
    extract::{MatchedPath, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use crate::http_error::ResultExt;

use crate::{AppState, auth::AuthUser};

/// Routes a globally-banned user is still allowed to call.
/// Patterns are `MatchedPath` strings (e.g. `/api/v3/templates/{id}`).
const BAN_ALLOW_LIST: &[&str] = &[
    "/api/v3/templates",
    "/api/v3/templates/{id}",
    "/api/v3/templates/{id}/preview",
    "/api/v3/templates/{id}/png",
    "/api/v3/templates/{id}/wall-dev",
    "/api/v3/templates/{id}/charity",
    "/api/v3/templates/pinned",
    "/api/v3/clans",
    "/api/v3/clans/{id}",
    "/api/v3/clans/{id}/templates",
    "/api/v3/chats/global",
    "/api/v3/telemetry/health",
    "/api/v3/telemetry/metrics",
    // Auth/session management (needed to keep a token alive and call appeal).
    "/api/v3/auth/site",
    "/api/v3/auth/oauth/{provider}/start",
    "/api/v3/auth/oauth/{provider}/callback",
    "/api/v3/auth/refresh",
    "/api/v3/auth/session",
    "/api/v3/auth/logout",
    "/api/v3/auth/session/{sessionId}/logout",
    "/api/v3/auth/session/all/logout",
    "/api/v3/auth/recover",
    // The appeal endpoint and self-service restriction view.
    "/api/v3/users/me/appeal",
    "/api/v3/users/me/restrictions",
];

/// Returns true if the matched path is reachable by a globally banned user.
fn is_ban_exempt(matched: &str) -> bool {
    BAN_ALLOW_LIST.iter().any(|pattern| matched == *pattern)
}

/// Extract a Bearer token from the Authorization header, if present.
fn extract_bearer(request: &Request) -> Option<&str> {
    let header = request.headers().get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    header.strip_prefix("Bearer ")
}

/// Build a structured 403 response for a banned or restricted user.
async fn restriction_error_response(
    pool: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> Result<Response, (StatusCode, String)> {
    let row: Option<(String, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        r#"SELECT reason, expires_at
             FROM restrictions
            WHERE user_id = $1
              AND scope = 'global'
              AND s_ban = TRUE
              AND removed_at IS NULL
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY applied_at DESC
            LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .or_500()?;

    let (reason, expires_at) = row.unwrap_or_else(|| ("account restricted".to_string(), None));

    let body = json!({
        "error": "account_restricted",
        "message": "Your account is restricted. Please use /api/v3/users/me/restrictions to view details, /api/v3/users/me/appeal to submit an appeal, or contact platform administration.",
        "reason": reason,
        "expiresAt": expires_at,
        "appealUrl": "/api/v3/users/me/appeal",
        "restrictionsUrl": "/api/v3/users/me/restrictions",
    });

    Ok((StatusCode::FORBIDDEN, axum::Json(body)).into_response())
}

/// Verify that the access token's session is still active, using the cache
/// with a database fallback.
async fn validate_token_session(
    state: &AppState,
    claims: &crate::auth::Claims,
) -> Result<bool, (StatusCode, String)> {
    let session_id = match uuid::Uuid::parse_str(&claims.jti) {
        Ok(id) => id,
        Err(_) => return Ok(false),
    };

    // Cache lookup.
    if let Some(cached) = state.session_cache.get(session_id, &claims.token_hash).await {
        return Ok(cached);
    }

    // Database fallback.
    let valid = crate::auth::validate_session(&state.pool,
        session_id,
        &claims.token_hash,
    )
    .await
    .or_500()?;

    state
        .session_cache
        .set(session_id, claims.token_hash.clone(), valid)
        .await;

    Ok(valid)
}

/// Main V3 middleware. Verifies auth, validates the session, and enforces the
/// global ban policy.
pub async fn auth_and_ban_middleware(
    State(state): State<AppState>,
    matched_path: Option<MatchedPath>,
    mut request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    // 1. Verify JWT if present and store AuthUser in extensions.
    if let Some(token) = extract_bearer(&request) {
        if let Ok(claims) = crate::auth::verify_token(token, &state.config.jwt_secret) {
            // Reject tokens whose session has been revoked (logout) or expired.
            // This is the ONLY place session validity is enforced — handlers use
            // the `AuthUser` extractor, which re-decodes the JWT and does not
            // consult the session table. Falling through here (the previous
            // behaviour) let a logged-out but unexpired access token keep
            // authenticating for the full token lifetime.
            let session_valid = validate_token_session(&state, &claims).await?;
            if !session_valid {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "session expired or revoked".to_string(),
                ));
            }
            if let Ok(user_id) = uuid::Uuid::parse_str(&claims.sub) {
                request.extensions_mut().insert(AuthUser { user_id });
            }
        }
    }

    // 2. Global-ban gate for authenticated users.
    if let Some(user) = request.extensions().get::<AuthUser>() {
        let banned = crate::routes::v3::utils::sanctions::has_sanction(
            &state.pool,
            user.user_id,
            &crate::routes::v3::utils::sanctions::Sanction::Ban,
            None,
        )
        .await
        .or_500()?;

        if banned {
            if let Some(path) = matched_path.as_ref().map(|m| m.as_str()) {
                if !is_ban_exempt(path) {
                    return restriction_error_response(&state.pool, user.user_id).await;
                }
            }
        }
    }

    Ok(next.run(request).await)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::is_ban_exempt;

    #[test]
    fn public_templates_exempt() {
        assert!(is_ban_exempt("/api/v3/templates"));
        assert!(is_ban_exempt("/api/v3/templates/{id}"));
        assert!(is_ban_exempt("/api/v3/templates/{id}/wall-dev"));
    }

    #[test]
    fn public_clans_exempt() {
        assert!(is_ban_exempt("/api/v3/clans"));
        assert!(is_ban_exempt("/api/v3/clans/{id}"));
        assert!(is_ban_exempt("/api/v3/clans/{id}/templates"));
    }

    #[test]
    fn auth_and_appeal_exempt() {
        assert!(is_ban_exempt("/api/v3/auth/site"));
        assert!(is_ban_exempt("/api/v3/auth/refresh"));
        assert!(is_ban_exempt("/api/v3/auth/session"));
        assert!(is_ban_exempt("/api/v3/users/me/appeal"));
        assert!(is_ban_exempt("/api/v3/users/me/restrictions"));
    }

    #[test]
    fn write_routes_not_exempt() {
        assert!(!is_ban_exempt("/api/v3/chats/{id}/messages"));
        assert!(!is_ban_exempt("/api/v3/templates/new"));
        assert!(!is_ban_exempt("/api/v3/clans/{id}/invites"));
        assert!(!is_ban_exempt("/api/v3/moderation/reports"));
    }

    #[test]
    fn literal_id_does_not_match_pattern() {
        // axum MatchedPath uses placeholders, not literal IDs.
        assert!(!is_ban_exempt("/api/v3/templates/550e8400-e29b-41d4-a716-446655440000"));
    }
}
