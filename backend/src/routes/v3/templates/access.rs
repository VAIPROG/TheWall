//! Flexible access control for V3 template read/export/render endpoints.
//!
//! Public approved templates are readable without any authentication. Clan and
//! private templates require one of:
//!   - Bearer JWT (Authorization: Bearer <token>)
//!   - API key (Authorization: Bearer <api-key> or X-Api-Key: <api-key>)
//!   - Session token passed as `?session=<token>`
//!   - Per-template password passed as `?password=<password>`
//!
//! Global moderators and admins can also read any template as part of their
//! moderation duties.

use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;

#[derive(Debug, Clone, Deserialize)]
pub struct AccessQuery {
    pub session: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AccessContext {
    pub user_id: Option<Uuid>,
    pub password: Option<String>,
}


/// Extractor that resolves optional authentication for template read paths.
/// Never rejects — a missing/invalid credential simply yields a context with
/// `user_id: None`, which is fine for public templates.
#[derive(Debug, Clone)]
pub struct TemplateAccess {
    pub context: AccessContext,
}

impl FromRequestParts<AppState> for TemplateAccess {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let query = parse_access_query(parts.uri.query());

        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());

        let api_key_header = parts
            .headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok());

        let mut context = AccessContext {
            user_id: None,
            password: query.password,
        };

        // 1. Try Bearer JWT.
        if let Some(header) = auth_header {
            if let Some(token) = header.strip_prefix("Bearer ") {
                // Distinguish JWT from API key: JWTs contain two dots in the payload.
                if token.chars().filter(|&c| c == '.').count() >= 2 {
                    if let Ok(claims) = crate::auth::verify_token(token, &state.config.jwt_secret) {
                        if let Ok(uid) = Uuid::parse_str(&claims.sub) {
                            context.user_id = Some(uid);
                        }
                    }
                } else {
                    // Treat as API key.
                    if let Some(uid) = verify_api_key(&state.pool, token).await {
                        context.user_id = Some(uid);
                    }
                }
            }
        }

        // 2. Try API key header if no user resolved yet.
        if context.user_id.is_none() {
            if let Some(key) = api_key_header {
                if let Some(uid) = verify_api_key(&state.pool, key).await {
                    context.user_id = Some(uid);
                }
            }
        }

        // 3. Try session query param. `<img>`/`<gif>` tags can't send an
        //    Authorization header, so preview/animated URLs pass credentials
        //    here instead: either an opaque session token, or — as a fallback —
        //    a Bearer JWT (the extension only holds the JWT, not a session id).
        if context.user_id.is_none() {
            if let Some(token) = query.session.as_deref() {
                if let Some(uid) = verify_session(&state.pool, token).await {
                    context.user_id = Some(uid);
                } else if token.chars().filter(|&c| c == '.').count() >= 2 {
                    if let Ok(claims) = crate::auth::verify_token(token, &state.config.jwt_secret) {
                        if let Ok(uid) = Uuid::parse_str(&claims.sub) {
                            context.user_id = Some(uid);
                        }
                    }
                }
            }
        }

        Ok(TemplateAccess { context })
    }
}

fn parse_access_query(query: Option<&str>) -> AccessQuery {
    let mut session = None;
    let mut password = None;
    if let Some(q) = query {
        for (key, value) in url::form_urlencoded::parse(q.as_bytes()) {
            match key.as_ref() {
                "session" => session = Some(value.into_owned()),
                "password" => password = Some(value.into_owned()),
                _ => {}
            }
        }
    }
    AccessQuery { session, password }
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    BASE64.encode(hasher.finalize())
}

async fn verify_api_key(pool: &sqlx::PgPool, key: &str) -> Option<Uuid> {
    let hash = hash_token(key);
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT user_id FROM api_keys WHERE token_hash = $1")
        .bind(&hash)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    row.map(|(uid,)| uid)
}

async fn verify_session(pool: &sqlx::PgPool, token: &str) -> Option<Uuid> {
    let hash = hash_token(token);
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()")
            .bind(&hash)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    row.map(|(uid,)| uid)
}

/// Verify a per-template password. Returns true if the password matches the
/// stored `access_password_hash` for the given template id.
pub async fn verify_template_password(
    pool: &sqlx::PgPool,
    template_id: Uuid,
    password: &str,
) -> bool {
    let hash = hash_token(password);
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT access_password_hash FROM templates WHERE id = $1 AND access_password_hash IS NOT NULL",
    )
    .bind(template_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    row.map(|(stored,)| stored == hash)
        .unwrap_or(false)
}

