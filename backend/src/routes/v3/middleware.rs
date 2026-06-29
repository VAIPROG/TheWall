//! V3 request middleware — authentication + global-ban gate.
//!
//! A single layer is applied to the whole `/api/v3` router. It:
//!   1. Verifies the `Authorization: Bearer <jwt>` header if present and stores
//!      the resulting `AuthUser` in request extensions so handlers (and the
//!      `AuthUser` extractor) can reuse it without re-decoding the JWT.
//!   2. If the caller is authenticated, checks whether the user is globally
//!      banned. Banned users may still reach a short allow-list of routes
//!      (public read endpoints, auth/session management, and `/me/appeal`).
//!
//! Public routes that do not use `AuthUser` naturally pass through when no
//! `Authorization` header is sent.

use axum::{
    extract::{MatchedPath, Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};

use crate::{AppState, auth::AuthUser};

/// Routes a globally-banned user is still allowed to call.
/// Patterns are `MatchedPath` strings (e.g. `/api/v3/templates/:id`).
const BAN_ALLOW_LIST: &[&str] = &[
    "/api/v3/templates",
    "/api/v3/templates/:id",
    "/api/v3/templates/:id/preview",
    "/api/v3/templates/:id/image",
    "/api/v3/templates/:id/wall-dev",
    "/api/v3/templates/:id/charity",
    "/api/v3/templates/pinned",
    "/api/v3/clans",
    "/api/v3/clans/:id",
    "/api/v3/clans/:id/templates",
    "/api/v3/chats/global",
    "/api/v3/telemetry/health",
    "/api/v3/telemetry/metrics",
    // Auth/session management (needed to keep a token alive and call appeal).
    "/api/v3/auth/site",
    "/api/v3/auth/oauth/:provider/start",
    "/api/v3/auth/oauth/:provider/callback",
    "/api/v3/auth/refresh",
    "/api/v3/auth/session",
    "/api/v3/auth/logout",
    "/api/v3/auth/session/:sessionId/logout",
    "/api/v3/auth/session/all/logout",
    "/api/v3/auth/recover",
    // The appeal endpoint itself.
    "/api/v3/users/me/appeal",
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

/// Main V3 middleware. Verifies auth and enforces the global ban policy.
pub async fn auth_and_ban_middleware(
    State(state): State<AppState>,
    matched_path: Option<MatchedPath>,
    mut request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    // 1. Verify JWT if present and store AuthUser in extensions.
    if let Some(token) = extract_bearer(&request) {
        if let Ok(claims) = crate::auth::verify_token(token, &state.jwt_secret) {
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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        if banned {
            if let Some(path) = matched_path.as_ref().map(|m| m.as_str()) {
                if !is_ban_exempt(path) {
                    return Err((StatusCode::FORBIDDEN, "you are banned".to_string()));
                }
            }
        }
    }

    Ok(next.run(request).await)
}
