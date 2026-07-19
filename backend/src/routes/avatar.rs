use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::routes::identicon;
use crate::{AppState, auth::AuthUser, models::AvatarRequest};

#[derive(Debug, Deserialize)]
pub struct AvatarQuery {
    #[serde(rename = "userId")]
    pub user_id: String,
}

#[derive(Debug, Serialize)]
struct AvatarResponse {
    image: String,
}

#[derive(sqlx::FromRow)]
struct ImageRow {
    image: String,
}

// Decode a data: URL into (mime, bytes). Falls back to image/png if no mime.
pub(crate) fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let trimmed = data_url.strip_prefix("data:")?;
    let (header_part, b64_part) = trimmed.split_once(",")?;
    let mime = header_part
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    let bytes = BASE64.decode(b64_part).ok()?;
    Some((mime, bytes))
}

pub(crate) fn image_response(mime: String, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=300")
        .body(Body::from(bytes))
        .unwrap()
}

// PUT /me/avatar — upload (accepts any common format, stores as WebP @ 256×256)
pub async fn update_my_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<AvatarRequest>,
) -> impl IntoResponse {
    // Validate size — max ~10 MB raw image (≈ 14 MB base64 data URL)
    if body.image.len() > 14_500_000 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "image too large (max 10 MB)"})),
        )
            .into_response();
    }

    // Decode the data URL to raw bytes
    let (_mime, bytes) = match decode_data_url(&body.image) {
        Some(t) => t,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid data URL"})),
            )
                .into_response();
        }
    };

    // Decode image, resize to 256×256 (fit inside), encode as WebP
    let webp_bytes = match encode_webp(&bytes, 256) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("avatar webp encode failed: {e}");
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(serde_json::json!({"error": "could not process image"})),
            )
                .into_response();
        }
    };
    let data_url = format!("data:image/webp;base64,{}", BASE64.encode(&webp_bytes));

    let result = sqlx::query(
        "INSERT INTO avatars (user_id, image, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET image = EXCLUDED.image, updated_at = NOW()",
    )
    .bind(auth.user_id)
    .bind(&data_url)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // Invalidate the cached fallback so the new upload shows immediately.
            avatar_cache_evict(auth.user_id);
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok": true, "size": webp_bytes.len()})),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("update_my_avatar db error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "db"})),
            )
                .into_response()
        }
    }
}

pub(crate) fn encode_webp(bytes: &[u8], max_side: u32) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;
    let img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    let img = if img.width() > max_side || img.height() > max_side {
        img.resize(max_side, max_side, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let rgba = img.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    let webp_data = encoder.encode(85.0);
    Ok(webp_data.to_vec())
}

// DELETE /me/avatar — clear custom avatar, fall back to Discord one
pub async fn delete_my_avatar(auth: AuthUser, State(state): State<AppState>) -> impl IntoResponse {
    let r = sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await;
    match r {
        Ok(_) => {
            // Invalidate the cache so the next request falls back (Discord →
            // identicon) immediately rather than serving the stale custom one.
            avatar_cache_evict(auth.user_id);
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => {
            tracing::error!("delete_my_avatar db error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "db"})),
            )
                .into_response()
        }
    }
}

// GET /me/avatar — returns the raw data URL JSON (for editing UI)
pub async fn get_my_avatar(auth: AuthUser, State(state): State<AppState>) -> impl IntoResponse {
    let row = sqlx::query_as::<_, ImageRow>("SELECT image FROM avatars WHERE user_id = $1")
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await;
    match row {
        Ok(Some(r)) => (StatusCode::OK, Json(AvatarResponse { image: r.image })).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "no avatar"})),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get_my_avatar db error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "db"})),
            )
                .into_response()
        }
    }
}

// GET /avatar?userId=<uuid_or_wall_id> — returns binary image for <img src>
pub async fn get_avatar(
    Query(params): Query<AvatarQuery>,
    State(state): State<AppState>,
) -> Response {
    tracing::debug!("get_avatar: userId={}", params.user_id);

    // Try as UUID first, then fallback to wall_id
    let user_id_opt: Option<Uuid> = if let Ok(uuid) = Uuid::parse_str(&params.user_id) {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1")
            .bind(uuid)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
    } else {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE external_id = $1")
            .bind(&params.user_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
    };

    let user_id = match user_id_opt {
        Some(id) => id,
        None => {
            tracing::debug!("get_avatar: user not found for userId={}", params.user_id);
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    fetch_avatar_cached(user_id, &state).await
}

/// Shared avatar resolution behind every avatar read path (`/avatar`,
/// `/api/v2/avatar/{id}`, `/api/v3/users/{ref}/avatar`). For a *known* user it
/// never returns 404 — it walks a fallback chain and always ends with a
/// generated identicon:
///
///   1. custom upload (the `avatars` table),
///   2. the account's linked Discord avatar (if a verified discord link exists),
///   3. a deterministic identicon derived from the user id.
///
/// The chosen image is cached for [`AVATAR_CACHE_TTL`] keyed by user id; avatar
/// uploads/deletes evict the entry so changes appear immediately.
async fn fetch_avatar_cached(user_id: Uuid, state: &AppState) -> Response {
    // Cache hit. Post-change entries are always `Some`; a legacy `None` entry
    // is treated as a miss so it re-resolves through the new chain.
    {
        let cache = avatar_cache().lock().unwrap();
        if let Some(entry) = cache.get(&user_id) {
            if entry.fetched_at.elapsed() < AVATAR_CACHE_TTL {
                if let Some((mime, bytes)) = &entry.data {
                    tracing::debug!("get_avatar: cache hit for user_id={user_id}");
                    return image_response(mime.clone(), bytes.clone());
                }
            }
        }
    }

    // 1. Custom upload.
    let custom = sqlx::query_as::<_, ImageRow>("SELECT image FROM avatars WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| decode_data_url(&r.image));
    if let Some((mime, bytes)) = custom {
        tracing::debug!("get_avatar: custom avatar for user_id={user_id}");
        avatar_cache_insert(user_id, Some((mime.clone(), bytes.clone())));
        return image_response(mime, bytes);
    }

    // 2. Linked Discord avatar.
    if let Some(discord_uid) = discord_uid_for(user_id, state).await {
        if let Some((mime, bytes)) = discord_avatar_bytes(&discord_uid, state).await {
            tracing::debug!("get_avatar: discord fallback for user_id={user_id}");
            avatar_cache_insert(user_id, Some((mime.clone(), bytes.clone())));
            return image_response(mime, bytes);
        }
    }

    // 3. Generated identicon — always succeeds, so this path never 404s.
    tracing::debug!("get_avatar: identicon fallback for user_id={user_id}");
    let bytes = identicon::identicon_svg(&user_id.to_string(), 256).into_bytes();
    let mime = "image/svg+xml; charset=utf-8".to_string();
    avatar_cache_insert(user_id, Some((mime.clone(), bytes.clone())));
    image_response(mime, bytes)
}

/// Return the account's verified Discord snowflake, if it has one, so the
/// avatar chain can fall back to the Discord CDN. Prefers the V3 `provider_links`
/// table (backfilled from the legacy `users.discord_id`).
async fn discord_uid_for(user_id: Uuid, state: &AppState) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT provider_uid FROM provider_links \
         WHERE account_id = $1 AND provider = 'discord' AND is_verified \
         ORDER BY linked_at LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

// GET /api/v3/users/{user_ref}/avatar — the advanced avatar path. Resolves the
// ref (UUID or site external_id) then serves the full fallback chain. Never
// 404s for a resolvable user; an unresolvable ref still yields a stable
// identicon so `<img>` never breaks.
pub async fn get_user_avatar_v3(
    Path(user_ref): Path<String>,
    State(state): State<AppState>,
) -> Response {
    let user_id_opt: Option<Uuid> = if let Ok(uuid) = Uuid::parse_str(&user_ref) {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1")
            .bind(uuid)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
    } else {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE external_id = $1")
            .bind(&user_ref)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
    };

    match user_id_opt {
        Some(user_id) => fetch_avatar_cached(user_id, &state).await,
        None => {
            // Unknown ref: keep `<img>` intact with a ref-seeded identicon.
            tracing::debug!("get_user_avatar_v3: unresolved ref={user_ref}, serving identicon");
            identicon::svg_response(identicon::identicon_svg(&user_ref, 256))
        }
    }
}

// GET /api/v2/avatar/{user_id} — path-based variant, same cache
pub async fn get_avatar_v2(
    Path(user_id): Path<Uuid>,
    State(state): State<AppState>,
) -> Response {
    tracing::debug!("get_avatar_v2: user_id={user_id}");
    fetch_avatar_cached(user_id, &state).await
}

// -------- Avatar LRU cache --------

pub struct AvatarCacheEntry {
    pub data: Option<(String, Vec<u8>)>,
    pub fetched_at: Instant,
}

const AVATAR_CACHE_TTL: Duration = Duration::from_secs(5 * 60); // 5 minutes
const AVATAR_CACHE_MAX: usize = 500;

fn avatar_cache() -> &'static Mutex<HashMap<Uuid, AvatarCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<Uuid, AvatarCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Store result in the avatar cache, evicting oldest entry when over limit.
fn avatar_cache_insert(user_id: Uuid, data: Option<(String, Vec<u8>)>) {
    let mut cache = avatar_cache().lock().unwrap();
    if cache.len() >= AVATAR_CACHE_MAX && !cache.contains_key(&user_id) {
        // Evict oldest entry by fetched_at
        let oldest = cache
            .iter()
            .min_by_key(|(_, e)| e.fetched_at)
            .map(|(k, _)| *k);
        if let Some(key) = oldest {
            cache.remove(&key);
        }
    }
    cache.insert(user_id, AvatarCacheEntry { data, fetched_at: Instant::now() });
}

/// Drop a user's cached avatar so the next request re-resolves the fallback
/// chain immediately. Called after a custom avatar is uploaded or deleted so
/// the change is visible right away instead of waiting out the cache TTL.
fn avatar_cache_evict(user_id: Uuid) {
    avatar_cache().lock().unwrap().remove(&user_id);
}

// -------- Discord avatar proxy --------

#[derive(Debug, Deserialize)]
struct DiscordUser {
    avatar: Option<String>,
}

struct DiscordCacheEntry {
    bytes: Vec<u8>,
    mime: String,
    cached_at: Instant,
}

// ---- Discord rate limiter --------------------------------------------------
//
// Discord enforces per-route + global rate limits. We funnel all /users/{id}
// requests through a single tokio mutex, and on 429 we sleep for the
// Retry-After header (with a 30s ceiling) before letting the next request
// through. There's also a small inter-request spacing so we never burst.
//
// Combined with the existing in-process avatar cache (7 day positive,
// 15 min negative), this is enough to keep us well under any rate limit
// for a community of a few thousand discord IDs.

use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex as TokioMutex;

static DISCORD_USERS_MUTEX: TokioMutex<()> = TokioMutex::const_new(());
static DISCORD_USERS_BLOCKED_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
const DISCORD_USERS_MIN_SPACING_MS: u64 = 250;
static DISCORD_USERS_LAST_FIRED_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wait until the discord-users bucket lets us go, then fire one request.
/// Re-tries up to `max_attempts` times on 429 honoring Retry-After.
async fn discord_users_get(
    client: &reqwest::Client,
    token: &str,
    discord_id: &str,
    max_attempts: u8,
) -> Result<reqwest::Response, String> {
    // Serialize: one in-flight request for /users at a time.
    let _guard = DISCORD_USERS_MUTEX.lock().await;
    let url = format!("https://discord.com/api/v10/users/{}", discord_id);

    for attempt in 1..=max_attempts {
        // Respect any global pause we set after a previous 429.
        let blocked_until = DISCORD_USERS_BLOCKED_UNTIL_MS.load(Ordering::Relaxed);
        let now = now_ms();
        if blocked_until > now {
            let wait = blocked_until - now;
            tracing::info!("discord rate-limit: sleeping {}ms before request", wait);
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }

        // Enforce the inter-request spacing so we never burst.
        let last = DISCORD_USERS_LAST_FIRED_MS.load(Ordering::Relaxed);
        let since = now_ms().saturating_sub(last);
        if since < DISCORD_USERS_MIN_SPACING_MS {
            tokio::time::sleep(Duration::from_millis(
                DISCORD_USERS_MIN_SPACING_MS - since,
            ))
            .await;
        }
        DISCORD_USERS_LAST_FIRED_MS.store(now_ms(), Ordering::Relaxed);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        if status.as_u16() == 429 {
            // Prefer the JSON `retry_after` (in seconds) because Discord's
            // Retry-After header is sometimes missing on the cloudfront edge.
            let retry_secs = parse_retry_after(&resp).await.unwrap_or(1.0);
            let retry_ms = (retry_secs * 1000.0).clamp(250.0, 30_000.0) as u64;
            DISCORD_USERS_BLOCKED_UNTIL_MS
                .store(now_ms() + retry_ms, Ordering::Relaxed);
            tracing::warn!(
                "discord 429 on /users/{} attempt {}/{}: retry in {}ms",
                discord_id, attempt, max_attempts, retry_ms,
            );
            if attempt == max_attempts {
                return Err(format!("rate limited after {} attempts", max_attempts));
            }
            tokio::time::sleep(Duration::from_millis(retry_ms)).await;
            continue;
        }
        return Ok(resp);
    }
    Err("rate limited (exhausted attempts)".into())
}

/// Parse Discord's 429 retry hint. Falls back to the Retry-After response
/// header if the JSON body is missing.
async fn parse_retry_after(resp: &reqwest::Response) -> Option<f64> {
    if let Some(h) = resp.headers().get("retry-after") {
        if let Ok(s) = h.to_str() {
            if let Ok(v) = s.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

fn discord_cache() -> &'static Mutex<HashMap<String, DiscordCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, DiscordCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const DISCORD_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600); // 7 days
const DISCORD_NEGATIVE_TTL: Duration = Duration::from_secs(15 * 60); // 15 min for misses

// DELETE /discord/avatar?userId=<discord_snowflake> — clear from cache
pub async fn clear_discord_cache(Query(params): Query<AvatarQuery>) -> Response {
    let mut cache = discord_cache().lock().unwrap();
    cache.remove(&params.user_id);
    (
        StatusCode::OK,
        Json(serde_json::json!({"ok": true, "cleared": params.user_id})),
    )
        .into_response()
}

// GET /discord/avatar?userId=<discord_snowflake>
pub async fn get_discord_avatar(
    State(state): State<AppState>,
    Query(params): Query<AvatarQuery>,
) -> Response {
    tracing::debug!("get_discord_avatar: discord_id={}", params.user_id);
    match discord_avatar_bytes(&params.user_id, &state).await {
        Some((mime, bytes)) => image_response(mime, bytes),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Resolve a Discord snowflake to avatar bytes (WebP, or raw GIF for animated
/// avatars), going through the shared positive/negative cache + rate limiter.
/// Returns `None` when the id is unknown or the CDN fetch fails. This is the
/// reusable core behind both `GET /discord/avatar` and the user avatar chain.
async fn discord_avatar_bytes(discord_id: &str, state: &AppState) -> Option<(String, Vec<u8>)> {
    // Check cache (positive + negative).
    {
        let cache = discord_cache().lock().unwrap();
        if let Some(entry) = cache.get(discord_id) {
            if entry.bytes.is_empty() {
                if entry.cached_at.elapsed() < DISCORD_NEGATIVE_TTL {
                    tracing::debug!("discord_avatar_bytes: negative cache hit for {discord_id}");
                    return None;
                }
            } else if entry.cached_at.elapsed() < DISCORD_CACHE_TTL {
                tracing::debug!(
                    "discord_avatar_bytes: cache hit for {discord_id} ({} bytes)",
                    entry.bytes.len()
                );
                return Some((entry.mime.clone(), entry.bytes.clone()));
            }
        }
    }

    // Match the env name used by main.rs (DISCORD_BOT_TOKEN). The historical
    // `DISCORD_BOT` is kept as a fallback so an existing operator env file
    // with the older name keeps working.
    let bot_token = state
        .config
        .oauth
        .discord_bot_token
        .clone()
        .or_else(|| crate::config::opt_env("DISCORD_BOT"));
    if bot_token.is_none() {
        tracing::warn!(
            "discord_avatar_bytes({discord_id}): no bot token (DISCORD_BOT_TOKEN unset) — falling back to embed avatar"
        );
    }
    let client = reqwest::Client::new();

    // 1. Get avatar hash via Discord API (rate-limited).
    let avatar_hash: Option<String> = if let Some(token) = bot_token {
        match discord_users_get(&client, &token, discord_id, 3).await {
            Ok(r) if r.status().is_success() => {
                let parsed: Option<DiscordUser> = r.json().await.ok();
                parsed.and_then(|u| u.avatar)
            }
            Ok(r) => {
                tracing::warn!(
                    "discord_avatar_bytes({discord_id}): Discord API status {}",
                    r.status()
                );
                None
            }
            Err(e) => {
                tracing::warn!("discord_avatar_bytes({discord_id}): Discord API err {}", e);
                None
            }
        }
    } else {
        None
    };

    // 2. Build CDN URL (custom hash, else the deterministic embed default).
    let cdn_url = if let Some(hash) = avatar_hash {
        let ext = if hash.starts_with("a_") { "gif" } else { "png" };
        format!(
            "https://cdn.discordapp.com/avatars/{}/{}.{}?size=128",
            discord_id, hash, ext
        )
    } else {
        let idx = discord_id
            .parse::<u128>()
            .ok()
            .map(|n| ((n >> 22) % 6) as u8)
            .unwrap_or(0);
        format!("https://cdn.discordapp.com/embed/avatars/{}.png", idx)
    };

    // 3. Fetch image bytes.
    match client.get(&cdn_url).send().await {
        Ok(r) if r.status().is_success() => {
            let src_mime = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            match r.bytes().await {
                Ok(bytes) => {
                    let raw = bytes.to_vec();
                    // Animated GIF avatars start with "a_" — keep them raw.
                    let (final_mime, final_bytes) = if src_mime == "image/gif" {
                        (src_mime, raw)
                    } else {
                        match encode_webp(&raw, 128) {
                            Ok(w) => ("image/webp".to_string(), w),
                            Err(_) => (src_mime, raw),
                        }
                    };
                    discord_cache().lock().unwrap().insert(
                        discord_id.to_string(),
                        DiscordCacheEntry {
                            bytes: final_bytes.clone(),
                            mime: final_mime.clone(),
                            cached_at: Instant::now(),
                        },
                    );
                    Some((final_mime, final_bytes))
                }
                Err(_) => None,
            }
        }
        _ => {
            // Negative cache so we don't hammer Discord for unknown IDs. An
            // empty `bytes` marks the miss; the read side honours it for
            // `DISCORD_NEGATIVE_TTL`. Use `Instant::now()` directly —
            // `Instant - Duration` can panic on underflow shortly after process
            // start (the monotonic clock's origin may be < the subtrahend).
            discord_cache().lock().unwrap().insert(
                discord_id.to_string(),
                DiscordCacheEntry {
                    bytes: Vec::new(),
                    mime: String::new(),
                    cached_at: Instant::now(),
                },
            );
            None
        }
    }
}
