//! Account linking flows:
//!
//!  * Telegram — modern OIDC (Authorization Code + PKCE).
//!    Auth endpoint: https://oauth.telegram.org/auth, token endpoint:
//!    https://oauth.telegram.org/token, JWKS:
//!    https://oauth.telegram.org/.well-known/jwks.json . We register Allowed
//!    URLs in @BotFather → Web Login, get Client ID + Secret, run a normal
//!    code-for-token exchange, then validate the id_token JWT against
//!    Telegram's published RS256 public keys before extracting user claims.
//!    Docs: https://core.telegram.org/bots/telegram-login
//!
//!  * Discord — standard OAuth2 authorization-code with scope=identify.
//!    Callback lands on /vai-auth/; that page POSTs code + state to
//!    /me/links/discord/exchange where we trade code for token, fetch
//!    /users/@me, save id + username.
//!    Docs: https://discord.com/developers/docs/topics/oauth2
//!
//!  * Email — we run no SMTP. The user requests a short verification code,
//!    gets a template email body, mails it to support@. An admin sees the
//!    request in the admin panel and approves, which stamps the email onto
//!    users.notifications_email.

use std::time::Duration;

use axum::{
    Json,
    extract::{State},
    http::StatusCode,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};

use super::achievements;
use crate::{AppState, auth::AuthUser};

// ---------------------------------------------------------------------------
// Common: status of every link the current user has
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct LinkStatus {
    pub discord_id: Option<String>,
    pub discord_username: Option<String>,
    pub discord_linked_via_oauth: bool,
    pub telegram_user_id: Option<String>,
    pub telegram_username: Option<String>,
    pub telegram_photo_url: Option<String>,
    pub email: Option<String>,
    pub email_request_status: Option<String>,
}

pub async fn get_status(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<LinkStatus>, (StatusCode, String)> {
    let row: (
        Option<String>,
        Option<String>,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        r#"SELECT discord_id, discord_username, COALESCE(discord_linked_via_oauth, FALSE),
                  telegram_user_id, telegram_username, telegram_photo_url,
                  notifications_email
             FROM users WHERE id = $1"#,
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let last_request: Option<String> = sqlx::query_scalar(
        "SELECT status FROM email_link_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(LinkStatus {
        discord_id: row.0,
        discord_username: row.1,
        discord_linked_via_oauth: row.2,
        telegram_user_id: row.3,
        telegram_username: row.4,
        telegram_photo_url: row.5,
        email: row.6,
        email_request_status: last_request,
    }))
}

// ---------------------------------------------------------------------------
// Telegram OIDC (oauth.telegram.org)
// ---------------------------------------------------------------------------

const TG_AUTH_URL: &str = "https://oauth.telegram.org/auth";
const TG_TOKEN_URL: &str = "https://oauth.telegram.org/token";
const TG_JWKS_URL: &str = "https://oauth.telegram.org/.well-known/jwks.json";
const TG_ISSUER: &str = "https://oauth.telegram.org";

#[derive(Debug, Serialize)]
pub struct TelegramAuthUrl {
    pub url: String,
    pub state: String,
}

pub async fn telegram_oauth_url(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<TelegramAuthUrl>, (StatusCode, String)> {
    let client_id = telegram_client_id(&state)?;
    let redirect = state.config.oauth.discord_redirect_uri.clone(); // shared static page
    // 'tg.'-prefix lets the shared callback page identify the provider
    // without any client-side storage (extension-initiated flows have none).
    let s = format!("tg.{}", random_state());
    let verifier = random_state();
    let challenge = pkce_s256(&verifier);

    sqlx::query(
        "INSERT INTO oauth_states (state, user_id, provider, code_verifier) VALUES ($1, $2, 'telegram', $3)",
    )
    .bind(&s).bind(auth.user_id).bind(&verifier)
    .execute(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // `telegram:bot_access` asks the user's permission for our bot to DM them
    // after login — needed for grief alerts / snapshot pushes / etc.
    let url = format!(
        "{TG_AUTH_URL}?client_id={cid}&redirect_uri={uri}&response_type=code&scope={scope}&state={st}&code_challenge={ch}&code_challenge_method=S256",
        cid = url_encode(&client_id),
        uri = url_encode(&redirect),
        scope = url_encode("openid profile telegram:bot_access"),
        st = url_encode(&s),
        ch = url_encode(&challenge),
    );
    Ok(Json(TelegramAuthUrl { url, state: s }))
}

#[derive(Debug, Deserialize)]
pub struct TelegramExchangeRequest {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
struct TelegramTokenResp {
    #[allow(dead_code)]
    access_token: String,
    id_token: String,
}

/// Claims we expect from a Telegram OIDC id_token. Anything we ignore stays
/// unparsed.
#[derive(Debug, Deserialize)]
struct TelegramIdClaims {
    iss: String,
    aud: serde_json::Value, // can be string or array
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

pub async fn telegram_exchange(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<TelegramExchangeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Fail fast on missing config BEFORE consuming the one-shot state row —
    // the identity exchange re-reads these values itself.
    telegram_client_id(&state)?;
    state.config.oauth.telegram_client_secret.as_deref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "TELEGRAM_CLIENT_SECRET not configured".to_string(),
    ))?;

    // Consume the state row + recover the PKCE verifier.
    let st: Option<(uuid::Uuid, Option<String>)> = sqlx::query_as(
        r#"DELETE FROM oauth_states
            WHERE state = $1 AND provider = 'telegram' AND purpose = 'link'
              AND expires_at > NOW()
        RETURNING user_id, code_verifier"#,
    )
    .bind(&body.state)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (st_uid, verifier) = st.ok_or((
        StatusCode::BAD_REQUEST,
        "state expired or unknown".to_string(),
    ))?;
    if st_uid != auth.user_id {
        return Err((
            StatusCode::FORBIDDEN,
            "state does not belong to caller".into(),
        ));
    }
    let verifier = verifier.ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "no pkce verifier".to_string(),
    ))?;

    let identity = telegram_code_to_identity(&state, &body.code, &verifier).await?;
    let (tg_id, tg_username, tg_photo) = identity;

    sqlx::query(
        r#"UPDATE users
              SET telegram_user_id = $1,
                  telegram_username = $2,
                  telegram_photo_url = $3,
                  telegram_auth_date = NOW(),
                  updated_at = NOW()
            WHERE id = $4"#,
    )
    .bind(&tg_id)
    .bind(tg_username)
    .bind(&tg_photo)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = achievements::evaluate(&state.pool, auth.user_id).await;
    Ok(StatusCode::OK)
}

/// code+verifier → verified Telegram identity (id, username, photo). Shared
/// by the link flow (attaches to the signed-in user) and the login flow
/// (looks the user up BY this identity).
async fn telegram_code_to_identity(
    state: &AppState,
    code: &str,
    verifier: &str,
) -> Result<(String, Option<String>, Option<String>), (StatusCode, String)> {
    let client_id = telegram_client_id(state)?;
    let client_secret = state.config.oauth.telegram_client_secret.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "TELEGRAM_CLIENT_SECRET not configured".to_string(),
    ))?;
    let redirect = state.config.oauth.discord_redirect_uri.clone();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let basic = format!(
        "Basic {}",
        BASE64.encode(format!("{client_id}:{client_secret}"))
    );
    let form = build_form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier),
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
    let tg_id = claims
        .id
        .as_ref()
        .and_then(|v| match v {
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .or(claims.sub.clone())
        .ok_or((StatusCode::BAD_GATEWAY, "id_token: no id/sub".to_string()))?;
    Ok((tg_id, claims.preferred_username.or(claims.name), claims.picture))
}

pub async fn unlink_telegram(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query(
        r#"UPDATE users SET telegram_user_id = NULL, telegram_username = NULL,
                            telegram_photo_url = NULL, telegram_auth_date = NULL
            WHERE id = $1"#,
    )
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

fn telegram_client_id(state: &AppState) -> Result<String, (StatusCode, String)> {
    state.config.oauth.telegram_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "TELEGRAM_CLIENT_ID env missing".to_string(),
    ))
}

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
    // array reliably across providers — do a defensive recheck.
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

fn pkce_s256(verifier: &str) -> String {
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
// Discord OAuth2 (authorization-code)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DiscordAuthUrl {
    pub url: String,
    pub state: String,
}

pub async fn discord_oauth_url(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<DiscordAuthUrl>, (StatusCode, String)> {
    let client_id = state.config.oauth.discord_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth not configured".to_string(),
    ))?;
    let redirect = state.config.oauth.discord_redirect_uri.clone();

    // 32 chars of base64 — used as the OAuth `state` parameter to bind the
    // returned `code` back to our user.
    let s = format!("dc.{}", random_state());

    sqlx::query("INSERT INTO oauth_states (state, user_id, provider) VALUES ($1, $2, 'discord')")
        .bind(&s)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // `identify` gives us the user id and tag. Bot-DM permission is not a
    // separate OAuth scope on Discord — the bot can only DM users who share
    // a guild with it OR who started a DM thread first. The /me UI prompts
    // the user to do that after linking.
    let url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={cid}&redirect_uri={uri}&response_type=code&scope=identify&state={st}&prompt=consent",
        cid = url_encode(&client_id),
        uri = url_encode(&redirect),
        st = url_encode(&s),
    );
    Ok(Json(DiscordAuthUrl { url, state: s }))
}

#[derive(Debug, Deserialize)]
pub struct DiscordExchangeRequest {
    pub code: String,
    pub state: String,
}

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
}

pub async fn discord_exchange(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DiscordExchangeRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Fail fast on missing config BEFORE consuming the one-shot state row —
    // the identity exchange re-reads these values itself.
    state.config.oauth.discord_client_id.as_deref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth not configured".to_string(),
    ))?;
    state.config.oauth.discord_client_secret.as_deref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth secret missing".to_string(),
    ))?;

    // Look up + consume the state. The CSRF guarantee: only the same user
    // that requested the URL can finalise the link.
    let st: Option<uuid::Uuid> = sqlx::query_scalar(
        "DELETE FROM oauth_states WHERE state = $1 AND provider = 'discord' AND purpose = 'link' AND expires_at > NOW() RETURNING user_id",
    )
    .bind(&body.state)
    .fetch_optional(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let st_uid = st.ok_or((
        StatusCode::BAD_REQUEST,
        "state expired or unknown".to_string(),
    ))?;
    if st_uid != auth.user_id {
        return Err((
            StatusCode::FORBIDDEN,
            "state does not belong to caller".into(),
        ));
    }

    let u = discord_code_to_identity(&state, &body.code).await?;
    let pretty = u.global_name.unwrap_or_else(|| u.username.clone());
    sqlx::query(
        r#"UPDATE users
              SET discord_id = $1,
                  discord_username = $2,
                  discord_linked_via_oauth = TRUE,
                  updated_at = NOW()
            WHERE id = $3"#,
    )
    .bind(&u.id)
    .bind(&pretty)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = achievements::evaluate(&state.pool, auth.user_id).await;
    Ok(StatusCode::OK)
}

pub async fn unlink_discord(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Only unlink the OAuth-side override; the canonical Discord ID coming
    // from filianislost stays. We just stop using it for notifications.
    sqlx::query(
        r#"UPDATE users
              SET discord_linked_via_oauth = FALSE
            WHERE id = $1 AND discord_linked_via_oauth = TRUE"#,
    )
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Email-by-support flow
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct EmailRequest {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct EmailRequestResponse {
    pub code: String,
    pub send_to: String,
    pub subject: String,
    pub body_template: String,
    pub status: String,
}

pub async fn request_email_link(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<EmailRequest>,
) -> Result<Json<EmailRequestResponse>, (StatusCode, String)> {
    let proposed = b.email.trim().to_string();
    if !proposed.contains('@') || proposed.len() > 254 {
        return Err((StatusCode::BAD_REQUEST, "invalid email".into()));
    }
    // Generate a friendly short code: 6 chars from a no-ambiguous alphabet.
    const ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code: String = (0..6)
        .map(|_| ALPHA[rand::thread_rng().gen_range(0..ALPHA.len())] as char)
        .collect();

    sqlx::query(
        r#"INSERT INTO email_link_requests (user_id, proposed_email, code)
           VALUES ($1, $2, $3)"#,
    )
    .bind(auth.user_id)
    .bind(&proposed)
    .bind(&code)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let body = format!(
        "Hi VAI,\n\nPlease link the email address {proposed} to my The Wall Dev account.\n\n\
         Account username : {username}\n\
         Verification code: {code}\n\nThanks.",
    );

    Ok(Json(EmailRequestResponse {
        code,
        send_to: state.config.oauth.support_email.clone(),
        subject: "LINK-MAIL".into(),
        body_template: body,
        status: "pending".into(),
    }))
}
// ---- small helpers --------------------------------------------------------

fn random_state() -> String {
    let mut buf = [0u8; 24];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut buf);
    BASE64
        .encode(buf)
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

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

/// code → verified Discord identity. Shared by link + login flows.
async fn discord_code_to_identity(
    state: &AppState,
    code: &str,
) -> Result<DiscordUserResp, (StatusCode, String)> {
    let client_id = state.config.oauth.discord_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth not configured".to_string(),
    ))?;
    let client_secret = state.config.oauth.discord_client_secret.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth secret missing".to_string(),
    ))?;
    let redirect = state.config.oauth.discord_redirect_uri.clone();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let form = build_form(&[
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
    ]);
    let tok_resp = client
        .post("https://discord.com/api/v10/oauth2/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("token: {e}")))?;
    if !tok_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("discord token status {}", tok_resp.status()),
        ));
    }
    let tok: DiscordTokenResp = tok_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("token decode: {e}")))?;

    let user_resp = client
        .get("https://discord.com/api/v10/users/@me")
        .bearer_auth(&tok.access_token)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("user: {e}")))?;
    if !user_resp.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("discord user status {}", user_resp.status()),
        ));
    }
    user_resp
        .json()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("user decode: {e}")))
}

// ---------------------------------------------------------------------------
// OAuth SIGN-IN (no session required)
//
// The landing offers "Sign in with Telegram/Discord": anyone whose Wall
// account already carries the provider identity can authenticate cold. The
// state row uses purpose='login' with NULL user_id; the exchange resolves
// the verified provider id to a user and mints a session pair. Accounts are
// NEVER auto-created here — identity comes from filianislost via the site
// token, providers only re-authenticate it.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LoginExchangeRequest {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub refresh_token: String,
    pub username: String,
}

pub async fn telegram_login_url(
    State(state): State<AppState>,
) -> Result<Json<TelegramAuthUrl>, (StatusCode, String)> {
    let client_id = telegram_client_id(&state)?;
    let redirect = state.config.oauth.discord_redirect_uri.clone();
    // 'ltg.' prefix → the callback page routes to the login exchange.
    let s = format!("ltg.{}", random_state());
    let verifier = random_state();
    let challenge = pkce_s256(&verifier);
    sqlx::query(
        "INSERT INTO oauth_states (state, user_id, provider, purpose, code_verifier)
         VALUES ($1, NULL, 'telegram', 'login', $2)",
    )
    .bind(&s)
    .bind(&verifier)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let url = format!(
        "{TG_AUTH_URL}?client_id={cid}&redirect_uri={uri}&response_type=code&scope={scope}&state={st}&code_challenge={ch}&code_challenge_method=S256",
        cid = url_encode(&client_id),
        uri = url_encode(&redirect),
        scope = url_encode("openid profile telegram:bot_access"),
        st = url_encode(&s),
        ch = url_encode(&challenge),
    );
    Ok(Json(TelegramAuthUrl { url, state: s }))
}

pub async fn discord_login_url(
    State(state): State<AppState>,
) -> Result<Json<DiscordAuthUrl>, (StatusCode, String)> {
    let client_id = state.config.oauth.discord_client_id.clone().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "discord oauth not configured".to_string(),
    ))?;
    let redirect = state.config.oauth.discord_redirect_uri.clone();
    let s = format!("ldc.{}", random_state());
    sqlx::query(
        "INSERT INTO oauth_states (state, user_id, provider, purpose)
         VALUES ($1, NULL, 'discord', 'login')",
    )
    .bind(&s)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={cid}&redirect_uri={uri}&response_type=code&scope=identify&state={st}&prompt=consent",
        cid = url_encode(&client_id),
        uri = url_encode(&redirect),
        st = url_encode(&s),
    );
    Ok(Json(DiscordAuthUrl { url, state: s }))
}

pub async fn telegram_login_exchange(
    State(state): State<AppState>,
    Json(body): Json<LoginExchangeRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let st: Option<(Option<uuid::Uuid>, Option<String>)> = sqlx::query_as(
        r#"DELETE FROM oauth_states
            WHERE state = $1 AND provider = 'telegram' AND purpose = 'login'
              AND expires_at > NOW()
        RETURNING user_id, code_verifier"#,
    )
    .bind(&body.state)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (_, verifier) =
        st.ok_or((StatusCode::BAD_REQUEST, "state expired or unknown".to_string()))?;
    let verifier = verifier.ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "no pkce verifier".to_string(),
    ))?;

    let (tg_id, _, _) = telegram_code_to_identity(&state, &body.code, &verifier).await?;

    let user: Option<(uuid::Uuid, String)> =
        sqlx::query_as("SELECT id, username FROM users WHERE telegram_user_id = $1")
            .bind(&tg_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (uid, username) = user.ok_or((
        StatusCode::NOT_FOUND,
        "no Wall account is linked to this Telegram — link it first from the extension"
            .to_string(),
    ))?;
    let (token, refresh_token) =
        crate::auth::issue_session_pair(&state.pool, &state.config.jwt_secret, uid)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(LoginResponse {
        token,
        refresh_token,
        username,
    }))
}

pub async fn discord_login_exchange(
    State(state): State<AppState>,
    Json(body): Json<LoginExchangeRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    let st: Option<Option<uuid::Uuid>> = sqlx::query_scalar(
        r#"DELETE FROM oauth_states
            WHERE state = $1 AND provider = 'discord' AND purpose = 'login'
              AND expires_at > NOW()
        RETURNING user_id"#,
    )
    .bind(&body.state)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if st.is_none() {
        return Err((StatusCode::BAD_REQUEST, "state expired or unknown".to_string()));
    }

    let u = discord_code_to_identity(&state, &body.code).await?;

    let user: Option<(uuid::Uuid, String)> =
        sqlx::query_as("SELECT id, username FROM users WHERE discord_id = $1")
            .bind(&u.id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (uid, username) = user.ok_or((
        StatusCode::NOT_FOUND,
        "no Wall account is linked to this Discord — link it first from the extension"
            .to_string(),
    ))?;
    let (token, refresh_token) =
        crate::auth::issue_session_pair(&state.pool, &state.config.jwt_secret, uid)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(LoginResponse {
        token,
        refresh_token,
        username,
    }))
}
