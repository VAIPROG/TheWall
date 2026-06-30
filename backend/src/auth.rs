use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    /// Subject — user UUID as a string.
    pub sub: String,
    /// Expiry (Unix timestamp seconds).
    pub exp: usize,
    /// Issued-at (Unix timestamp seconds).
    pub iat: usize,
}

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

#[derive(Debug)]
#[allow(dead_code)] // jsonwebtoken payloads kept for Debug diagnostics
pub enum AuthError {
    TokenCreation(jsonwebtoken::errors::Error),
    TokenVerification(jsonwebtoken::errors::Error),
    MissingHeader,
    InvalidHeaderFormat,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let body = match &self {
            AuthError::MissingHeader => "Missing Authorization header",
            AuthError::InvalidHeaderFormat => "Authorization header must be 'Bearer <token>'",
            AuthError::TokenVerification(_) => "Invalid or expired token",
            AuthError::TokenCreation(_) => "Token creation failed",
        };
        (StatusCode::UNAUTHORIZED, body).into_response()
    }
}

/// Create a signed JWT for `user_id` that expires after `duration_hours`.
pub fn create_token(
    user_id: &Uuid,
    secret: &str,
    duration_hours: i64,
) -> Result<String, AuthError> {
    let now = Utc::now().timestamp() as usize;
    let exp = (Utc::now() + chrono::Duration::hours(duration_hours)).timestamp() as usize;

    let claims = Claims {
        sub: user_id.to_string(),
        iat: now,
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(AuthError::TokenCreation)
}

/// Verify a JWT and return its claims.
pub fn verify_token(token: &str, secret: &str) -> Result<Claims, AuthError> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(AuthError::TokenVerification)?;

    Ok(token_data.claims)
}

// ---------------------------------------------------------------------------
// Refresh token helpers
// ---------------------------------------------------------------------------

/// Generate a cryptographically-random 32-byte refresh token encoded as base64.
pub fn generate_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

/// Hash a token with SHA-256 and return a base64 string.
/// Use this before persisting refresh tokens so raw tokens are never stored.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    BASE64.encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// AuthUser extractor
// ---------------------------------------------------------------------------

/// Axum extractor that validates the Bearer JWT from the Authorization header.
/// Requires `State<AppState>` to be present in the router (for `jwt_secret`).
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Extract the Authorization header value.
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .ok_or(AuthError::MissingHeader)?
            .to_str()
            .map_err(|_| AuthError::InvalidHeaderFormat)?;

        // Expect "Bearer <token>".
        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(AuthError::InvalidHeaderFormat)?;

        let claims = verify_token(token, &state.config.jwt_secret)?;

        let user_id = Uuid::parse_str(&claims.sub).map_err(|_| {
            AuthError::TokenVerification(
                // Wrap as a verification error — sub is malformed.
                jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidSubject),
            )
        })?;

        Ok(AuthUser { user_id })
    }
}

// ---------------------------------------------------------------------------
// Merge token (single-use, short-lived, scope-locked)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MergeClaims {
    /// Subject — account B UUID as a string.
    pub sub: String,
    /// Scope must equal "merge" — distinguishes these tokens from access JWTs.
    pub scope: String,
    /// Expiry (Unix timestamp seconds).
    pub exp: usize,
    /// Issued-at (Unix timestamp seconds).
    pub iat: usize,
}

/// Mint a merge token proving ownership of `account_id`.  Expires after 600 s.
pub fn create_merge_token(account_id: &Uuid, secret: &str) -> Result<String, AuthError> {
    let now = Utc::now().timestamp() as usize;
    let exp = (Utc::now() + chrono::Duration::seconds(600)).timestamp() as usize;

    let claims = MergeClaims {
        sub: account_id.to_string(),
        scope: "merge".to_string(),
        iat: now,
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(AuthError::TokenCreation)
}

/// Verify a merge token and return the account-B UUID it names.
/// Returns an error if the token is expired, malformed, or has the wrong scope.
pub fn verify_merge_token(token: &str, secret: &str) -> Result<Uuid, AuthError> {
    let token_data = decode::<MergeClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(AuthError::TokenVerification)?;

    if token_data.claims.scope != "merge" {
        return Err(AuthError::TokenVerification(
            jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidSubject),
        ));
    }

    Uuid::parse_str(&token_data.claims.sub).map_err(|_| {
        AuthError::TokenVerification(
            jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidSubject),
        )
    })
}

// ---------------------------------------------------------------------------
// Session issuance (shared by site-token login and OAuth sign-in)
// ---------------------------------------------------------------------------

/// Mint a JWT + refresh token pair for `user_id` and persist the session row.
/// Same shape the v1 site-token login produces, so every consumer of the
/// `sessions` table treats OAuth sign-ins identically.
pub async fn issue_session_pair(
    pool: &sqlx::PgPool,
    jwt_secret: &str,
    user_id: Uuid,
) -> Result<(String, String), String> {
    let token = create_token(&user_id, jwt_secret, 24).map_err(|e| format!("{e:?}"))?;
    let refresh_token = generate_refresh_token();
    let refresh_expires = Utc::now() + chrono::Duration::days(7);
    sqlx::query(
        r#"INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, now())"#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(hash_token(&token))
    .bind(hash_token(&refresh_token))
    .bind(refresh_expires)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok((token, refresh_token))
}
