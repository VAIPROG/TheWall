//! Per-provider OAuth identity resolution for the V3 OAuth center.
//!
//! Each provider has:
//!   - an `authorize_url` builder (returns the redirect URL for step 1)
//!   - a `code_to_identity` implementation (step 2: exchange code for identity)
//!
//! Telegram uses full OIDC (Authorization Code + PKCE, RS256 id_token JWKS).
//! Discord uses OAuth2 authorization-code + PKCE + users/@me.
//! GitHub uses OAuth2 authorization-code + PKCE + /user (REST).
//!
//! PKCE is mandatory for all three.
use crate::http_error::ResultExt;

use std::time::Duration;

use axum::http::StatusCode;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use serde::Deserialize;

use crate::AppState;

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Telegram,
    Discord,
    GitHub,
}

impl Provider {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "telegram" => Some(Self::Telegram),
            "discord" => Some(Self::Discord),
            "github" => Some(Self::GitHub),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telegram => "telegram",
            Self::Discord => "discord",
            Self::GitHub => "github",
        }
    }
}

// ---------------------------------------------------------------------------
// Resolved provider identity
// ---------------------------------------------------------------------------

pub struct ProviderIdentity {
    /// Canonical provider name string ("telegram" | "discord" | "github").
    pub provider: &'static str,
    /// Opaque user id from the provider (always a string).
    pub uid: String,
    pub username: Option<String>,
    #[allow(dead_code)] // kept for future session/profile enrichment
    pub avatar_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Telegram constants
// ---------------------------------------------------------------------------

const TG_AUTH_URL: &str = "https://oauth.telegram.org/auth";
const TG_TOKEN_URL: &str = "https://oauth.telegram.org/token";
const TG_JWKS_URL: &str = "https://oauth.telegram.org/.well-known/jwks.json";
const TG_ISSUER: &str = "https://oauth.telegram.org";

// ---------------------------------------------------------------------------
// authorize_url — build the redirect URL for step 1
// ---------------------------------------------------------------------------

/// Build the authorization redirect URL for the given provider.
///
/// `code_challenge` must already be S256-encoded (use `pkce_s256`).
pub fn authorize_url(
    provider: Provider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    match provider {
        Provider::Telegram => format!(
            "{base}?client_id={cid}&redirect_uri={uri}&response_type=code\
             &scope={scope}&state={st}&code_challenge={ch}&code_challenge_method=S256",
            base = TG_AUTH_URL,
            cid = url_encode(client_id),
            uri = url_encode(redirect_uri),
            scope = url_encode("openid profile telegram:bot_access"),
            st = url_encode(state),
            ch = url_encode(code_challenge),
        ),
        Provider::Discord => format!(
            "https://discord.com/api/oauth2/authorize\
             ?client_id={cid}&redirect_uri={uri}&response_type=code\
             &scope=identify&state={st}&prompt=consent\
             &code_challenge={ch}&code_challenge_method=S256",
            cid = url_encode(client_id),
            uri = url_encode(redirect_uri),
            st = url_encode(state),
            ch = url_encode(code_challenge),
        ),
        Provider::GitHub => format!(
            "https://github.com/login/oauth/authorize\
             ?client_id={cid}&redirect_uri={uri}&scope=read%3Auser\
             &state={st}&code_challenge={ch}&code_challenge_method=S256",
            cid = url_encode(client_id),
            uri = url_encode(redirect_uri),
            st = url_encode(state),
            ch = url_encode(code_challenge),
        ),
    }
}

// ---------------------------------------------------------------------------
// code_to_identity — exchange authorization code for a verified identity
// ---------------------------------------------------------------------------

pub async fn code_to_identity(
    state: &AppState,
    provider: Provider,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ProviderIdentity, (StatusCode, String)> {
    match provider {
        Provider::Telegram => telegram_code_to_identity(state, code, code_verifier, redirect_uri).await,
        Provider::Discord => discord_code_to_identity(state, code, code_verifier, redirect_uri).await,
        Provider::GitHub => github_code_to_identity(state, code, code_verifier, redirect_uri).await,
    }
}

// ---------------------------------------------------------------------------
// Telegram OIDC identity
// (Ported byte-faithfully from routes/v2/links.rs — security-critical JWKS
//  RS256 verification kept exactly as proven.)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TelegramTokenResp {
    #[allow(dead_code)]
    access_token: String,
    id_token: String,
}

/// Claims we extract from Telegram's RS256 id_token.
#[derive(Debug, Deserialize)]
struct TelegramIdClaims {
    iss: String,
    aud: serde_json::Value, // can be string OR array — we recheck defensively
    exp: i64,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

async fn telegram_code_to_identity(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ProviderIdentity, (StatusCode, String)> {
    let client_id = state.config.oauth.telegram_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "TELEGRAM_CLIENT_ID not configured".to_string(),
    ))?;
    let client_secret = state.config.oauth.telegram_client_secret.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "TELEGRAM_CLIENT_SECRET not configured".to_string(),
    ))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .or_500()?;

    // Token endpoint: Basic auth (client_id:client_secret), form body with PKCE.
    let basic = format!(
        "Basic {}",
        BASE64.encode(format!("{client_id}:{client_secret}"))
    );
    let form = build_form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id.as_str()),
        ("code_verifier", code_verifier),
    ]);
    let tok_resp = client
        .post(TG_TOKEN_URL)
        .header("Authorization", basic)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("tg token: {e}")))?;

    if !tok_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("tg token status {}", tok_resp.status()),
        ));
    }
    let tok: TelegramTokenResp = tok_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("tg token decode: {e}")))?;

    let claims = verify_telegram_id_token(&client, &tok.id_token, &client_id)
        .await
        .map_err(|e| (StatusCode::UNAUTHORIZED, format!("id_token: {e}")))?;

    if claims.iss != TG_ISSUER {
        return Err((StatusCode::UNAUTHORIZED, "bad iss".into()));
    }
    if claims.exp < Utc::now().timestamp() {
        return Err((StatusCode::UNAUTHORIZED, "id_token expired".into()));
    }

    let uid = claims
        .id
        .as_ref()
        .and_then(|v| match v {
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .or(claims.sub.clone())
        .ok_or((StatusCode::BAD_GATEWAY, "id_token: no id/sub".to_string()))?;

    Ok(ProviderIdentity {
        provider: "telegram",
        uid,
        username: claims.preferred_username.or(claims.name),
        avatar_url: claims.picture,
    })
}

/// Verify the Telegram OIDC id_token via JWKS RS256.
/// Kept byte-faithful to the proven v2 implementation — security-critical.
async fn verify_telegram_id_token(
    client: &reqwest::Client,
    id_token: &str,
    expected_aud: &str,
) -> Result<TelegramIdClaims, String> {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};

    let hdr = decode_header(id_token).map_err(|e| format!("header: {e}"))?;
    let kid = hdr.kid.ok_or("id_token: missing kid")?;

    let jwks: serde_json::Value = client
        .get(TG_JWKS_URL)
        .send()
        .await
        .map_err(|e| format!("jwks fetch: {e}"))?
        .json()
        .await
        .map_err(|e| format!("jwks decode: {e}"))?;

    let keys = jwks["keys"].as_array().ok_or("jwks: no keys array")?;
    let jwk = keys
        .iter()
        .find(|k| k["kid"].as_str() == Some(kid.as_str()))
        .ok_or_else(|| format!("no key for kid {kid}"))?;

    let n = jwk["n"].as_str().ok_or("jwk: no n")?;
    let e = jwk["e"].as_str().ok_or("jwk: no e")?;
    let key = DecodingKey::from_rsa_components(n, e).map_err(|e| format!("rsa key: {e}"))?;

    let mut val = Validation::new(Algorithm::RS256);
    val.set_audience(&[expected_aud]);
    val.set_issuer(&[TG_ISSUER]);
    let data =
        decode::<TelegramIdClaims>(id_token, &key, &val).map_err(|e| format!("verify: {e}"))?;

    // jsonwebtoken's set_audience can't handle when aud is a single string vs
    // array reliably across providers — defensive recheck (from proven v2 code).
    let ok_aud = match &data.claims.aud {
        serde_json::Value::String(s) => s == expected_aud,
        serde_json::Value::Array(arr) => arr.iter().any(|v| v.as_str() == Some(expected_aud)),
        _ => false,
    };
    if !ok_aud {
        return Err("audience mismatch".into());
    }
    Ok(data.claims)
}

// ---------------------------------------------------------------------------
// Discord OAuth2 identity
// (Ported from routes/v2/links.rs — added code_verifier to form body.)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DiscordTokenResp {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct DiscordUserResp {
    id: String,
    username: String,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

async fn discord_code_to_identity(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ProviderIdentity, (StatusCode, String)> {
    let client_id = state.config.oauth.discord_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth not configured".to_string(),
    ))?;
    let client_secret = state.config.oauth.discord_client_secret.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth secret missing".to_string(),
    ))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .or_500()?;

    let form = build_form(&[
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ]);
    let tok_resp = client
        .post("https://discord.com/api/v10/oauth2/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord token: {e}")))?;

    if !tok_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("discord token status {}", tok_resp.status()),
        ));
    }
    let tok: DiscordTokenResp = tok_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord token decode: {e}")))?;

    let user_resp = client
        .get("https://discord.com/api/v10/users/@me")
        .bearer_auth(&tok.access_token)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord user: {e}")))?;

    if !user_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("discord user status {}", user_resp.status()),
        ));
    }
    let u: DiscordUserResp = user_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("discord user decode: {e}")))?;

    // Build avatar URL when avatar hash is present.
    let avatar_url = u.avatar.map(|hash| {
        format!("https://cdn.discordapp.com/avatars/{}/{}.png", u.id, hash)
    });
    let username = u.global_name.unwrap_or(u.username);

    Ok(ProviderIdentity {
        provider: "discord",
        uid: u.id,
        username: Some(username),
        avatar_url,
    })
}

// ---------------------------------------------------------------------------
// GitHub OAuth2 identity (new)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GitHubTokenResp {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResp {
    id: serde_json::Value, // GitHub returns id as a number
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    #[allow(dead_code)] // deserialized for completeness; uid=id, username=login
    name: Option<String>,
}

async fn github_code_to_identity(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ProviderIdentity, (StatusCode, String)> {
    let client_id = state.config.oauth.github_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "GITHUB_CLIENT_ID not configured".to_string(),
    ))?;
    let client_secret = state.config.oauth.github_client_secret.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "GITHUB_CLIENT_SECRET not configured".to_string(),
    ))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .or_500()?;

    // GitHub token exchange — must send Accept: application/json to get JSON back.
    let form = build_form(&[
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ]);
    let tok_resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("github token: {e}")))?;

    if !tok_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("github token status {}", tok_resp.status()),
        ));
    }
    let tok: GitHubTokenResp = tok_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("github token decode: {e}")))?;

    // GitHub REQUIRES a User-Agent header.
    let user_resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", tok.access_token))
        .header("User-Agent", "the-wall-dev")
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("github user: {e}")))?;

    if !user_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("github user status {}", user_resp.status()),
        ));
    }
    let u: GitHubUserResp = user_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("github user decode: {e}")))?;

    // GitHub returns id as a number; stringify it.
    let uid = match &u.id {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => return Err((StatusCode::BAD_GATEWAY, format!("github user id unexpected: {other}"))),
    };

    Ok(ProviderIdentity {
        provider: "github",
        uid,
        username: Some(u.login),
        avatar_url: u.avatar_url,
    })
}

// ---------------------------------------------------------------------------
// PKCE helpers — ported from routes/v2/links.rs
// ---------------------------------------------------------------------------

/// Generate a random PKCE code verifier (also used as OAuth `state`).
pub fn random_state() -> String {
    let mut buf = [0u8; 24];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut buf);
    BASE64
        .encode(buf)
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

/// Compute the S256 code challenge from a verifier (BASE64URL-encode of SHA-256).
pub fn pkce_s256(verifier: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(verifier.as_bytes());
    let d = h.finalize();
    BASE64
        .encode(d)
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

// ---------------------------------------------------------------------------
// Small shared helpers — ported from routes/v2/links.rs
// ---------------------------------------------------------------------------

fn build_form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(&mut out, "%{:02X}", b);
            }
        }
    }
    out
}
