//! VAI Account System — first stage.
//!
//! Standalone identity (email + password) shared across VAI-PROG services.
//! For The Wall we link a vai_account to one users row; signing in with a
//! VAI account lands you on the same data as signing in via filianislost.
//!
//! Today we expose:
//!   POST /api/v2/vai/signup    — create account + return JWT
//!   POST /api/v2/vai/login     — get JWT
//!   GET  /api/v2/vai/me        — basic info
//!   POST /api/v2/vai/link      — link the currently-signed-in Wall user to
//!                                a VAI account (using its JWT)
//!
//! The JWT is the same format as the Wall JWT but issued with `aud=vai` and
//! carrying `vai_account_id` as the subject. We don't accept it as a Wall
//! auth token — that part comes when SSO is fully wired up.
use crate::http_error::ResultExt;

use axum::{Json, extract::State, http::StatusCode};
use chrono::Utc;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, Deserialize)]
pub struct VaiClaims {
    pub sub: String, // vai_account_id
    pub aud: String, // "vai"
    pub exp: usize,
    pub iat: usize,
}

fn issue_vai_jwt(id: &Uuid, secret: &str) -> Result<String, String> {
    let now = Utc::now().timestamp() as usize;
    let claims = VaiClaims {
        sub: id.to_string(),
        aud: "vai".into(),
        exp: now + 60 * 60 * 24 * 7, // 7 days
        iat: now,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

fn verify_vai_jwt(tok: &str, secret: &str) -> Result<VaiClaims, String> {
    let mut val = Validation::default();
    val.set_audience(&["vai"]);
    let data = decode::<VaiClaims>(tok, &DecodingKey::from_secret(secret.as_bytes()), &val)
        .map_err(|e| e.to_string())?;
    Ok(data.claims)
}

fn hash_password(pw: &str) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
    use sha2::{Digest, Sha256};
    // For the stub we use SHA-256 + per-user salt (created at signup). In
    // production this will move to argon2 — the column shape stays the same.
    let mut salt = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut salt);
    let mut h = Sha256::new();
    h.update(&salt);
    h.update(pw.as_bytes());
    let digest = h.finalize();
    Ok(format!(
        "sha256${}${}",
        B64.encode(salt),
        B64.encode(digest)
    ))
}

fn verify_password(pw: &str, stored: &str) -> bool {
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
    use sha2::{Digest, Sha256};
    let parts: Vec<&str> = stored.splitn(3, '$').collect();
    if parts.len() != 3 || parts[0] != "sha256" {
        return false;
    }
    let Ok(salt) = B64.decode(parts[1].as_bytes()) else {
        return false;
    };
    let Ok(want) = B64.decode(parts[2].as_bytes()) else {
        return false;
    };
    let mut h = Sha256::new();
    h.update(&salt);
    h.update(pw.as_bytes());
    h.finalize().as_slice() == want.as_slice()
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthOk {
    pub token: String,
    pub account: VaiAccountView,
}

#[derive(Debug, Serialize)]
pub struct VaiAccountView {
    pub id: Uuid,
    pub email: String,
    pub display_name: Option<String>,
    pub verified: bool,
}

pub async fn signup(
    State(state): State<AppState>,
    Json(b): Json<SignupRequest>,
) -> Result<Json<AuthOk>, (StatusCode, String)> {
    let email = b.email.trim().to_string();
    let email_lc = email.to_ascii_lowercase();
    if !email_lc.contains('@') || email_lc.len() > 254 {
        return Err((StatusCode::BAD_REQUEST, "invalid email".into()));
    }
    if b.password.len() < 8 || b.password.len() > 256 {
        return Err((StatusCode::BAD_REQUEST, "password 8-256 chars".into()));
    }
    let hash = hash_password(&b.password).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let id = Uuid::new_v4();
    let r = sqlx::query(
        r#"INSERT INTO vai_accounts (id, email, email_lc, password_hash, display_name)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(id)
    .bind(&email)
    .bind(&email_lc)
    .bind(&hash)
    .bind(&b.display_name)
    .execute(&state.pool)
    .await;
    if let Err(e) = r {
        // 23505 is unique_violation
        let msg = e.to_string();
        if msg.contains("unique") || msg.contains("23505") {
            return Err((StatusCode::CONFLICT, "email already in use".into()));
        }
        return Err((StatusCode::INTERNAL_SERVER_ERROR, msg));
    }
    let token = issue_vai_jwt(&id, &state.config.jwt_secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(AuthOk {
        token,
        account: VaiAccountView {
            id,
            email,
            display_name: b.display_name,
            verified: false,
        },
    }))
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(b): Json<LoginRequest>,
) -> Result<Json<AuthOk>, (StatusCode, String)> {
    let email_lc = b.email.trim().to_ascii_lowercase();
    let row: Option<(Uuid, String, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT id, email, password_hash, display_name, verified FROM vai_accounts WHERE email_lc = $1",
    )
    .bind(&email_lc)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    let row = row.ok_or((StatusCode::UNAUTHORIZED, "invalid credentials".into()))?;
    if !verify_password(&b.password, &row.2) {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    }
    let token = issue_vai_jwt(&row.0, &state.config.jwt_secret)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(AuthOk {
        token,
        account: VaiAccountView {
            id: row.0,
            email: row.1,
            display_name: row.3,
            verified: row.4,
        },
    }))
}

#[derive(Debug, Deserialize)]
pub struct LinkRequest {
    pub vai_token: String,
}

pub async fn link_to_wall(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<LinkRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let claims = verify_vai_jwt(&b.vai_token, &state.config.jwt_secret)
        .map_err(|e| (StatusCode::UNAUTHORIZED, e))?;
    let vai_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "malformed vai sub".to_string()))?;

    sqlx::query("UPDATE users SET vai_account_id = $1, updated_at = NOW() WHERE id = $2")
        .bind(vai_id)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    sqlx::query(
        r#"INSERT INTO vai_links (vai_account_id, service, user_id)
           VALUES ($1, 'the-wall', $2) ON CONFLICT DO NOTHING"#,
    )
    .bind(vai_id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .or_500()?;
    // Kick the achievement evaluator so "vai_linked" pops.
    let _ = super::achievements::evaluate(&state.pool, auth.user_id).await;
    Ok(StatusCode::OK)
}
