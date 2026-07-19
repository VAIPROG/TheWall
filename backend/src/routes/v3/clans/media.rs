//! Clan avatar + banner: managed uploads with generated fallbacks.
//!
//! Mirrors the user avatar pipeline. Uploads (`POST`) are clan-admin gated and
//! re-encode to WebP; the bytes are stored in `clan_media` and `clans.avatar_url`
//! / `clans.banner_url` are set to point at the public serving endpoint. The
//! serving endpoints (`GET`) are public — reachable by `<img>` — and never 404:
//! they fall back to a deterministic identicon (avatar) or gradient (banner)
//! when there is no custom media, honouring moderation takedowns via the NULL
//! pointer.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::load_clan;
use crate::http_error::ResultExt;
use crate::routes::avatar::{decode_data_url, encode_webp, image_response};
use crate::routes::identicon;
use crate::routes::v3::templates::render::public_base_url;
use crate::routes::v3::utils::permissions::effective_clan_role;
use crate::{AppState, auth::AuthUser};

#[derive(Debug, Deserialize)]
pub struct ClanMediaUpload {
    /// A `data:` URL of the source image (any common format).
    pub image: String,
}

/// Avatars are square thumbnails; banners are wide headers.
const AVATAR_MAX_SIDE: u32 = 256;
const BANNER_MAX_SIDE: u32 = 1024;
/// ~10 MB raw image ≈ 14 MB base64 data URL.
const MAX_DATA_URL: usize = 14_500_000;

/// Require the caller to be a clan admin (or global admin+, folded in by
/// `effective_clan_role`). Returns 404 if the clan doesn't exist.
async fn require_clan_admin(
    state: &AppState,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    load_clan(&state.pool, clan_id)
        .await?
        .ok_or((StatusCode::NOT_FOUND, "clan not found".to_string()))?;
    let role = effective_clan_role(&state.pool, user_id, clan_id)
        .await
        .or_500()?
        .ok_or((StatusCode::FORBIDDEN, "not a clan member".to_string()))?;
    if !role.is_admin() {
        return Err((StatusCode::FORBIDDEN, "clan admin required".to_string()));
    }
    Ok(())
}

/// Shared upload: re-encode to WebP, store in `clan_media`, point the clan
/// column at the serving endpoint.
async fn upload_media(
    state: &AppState,
    user_id: Uuid,
    clan_id: Uuid,
    kind: &str,
    max_side: u32,
    body: ClanMediaUpload,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_clan_admin(state, user_id, clan_id).await?;

    if body.image.len() > MAX_DATA_URL {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "image too large (max 10 MB)".to_string(),
        ));
    }
    let (_mime, bytes) = decode_data_url(&body.image)
        .ok_or((StatusCode::BAD_REQUEST, "invalid data URL".to_string()))?;
    let webp = encode_webp(&bytes, max_side).map_err(|e| {
        tracing::warn!("clan {kind} webp encode failed: {e}");
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "could not process image".to_string(),
        )
    })?;
    let data_url = format!("data:image/webp;base64,{}", BASE64.encode(&webp));

    sqlx::query(
        "INSERT INTO clan_media (clan_id, kind, image, updated_at) \
         VALUES ($1, $2, $3, NOW()) \
         ON CONFLICT (clan_id, kind) DO UPDATE SET image = EXCLUDED.image, updated_at = NOW()",
    )
    .bind(clan_id)
    .bind(kind)
    .bind(&data_url)
    .execute(&state.pool)
    .await
    .or_500()?;

    let pointer = format!("{}/api/v3/clans/{}/{}", public_base_url(&state.config), clan_id, kind);
    let col = pointer_column(kind);
    sqlx::query(&format!(
        "UPDATE clans SET {col} = $1, updated_at = NOW() WHERE id = $2"
    ))
    .bind(&pointer)
    .bind(clan_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({ "ok": true, "url": pointer, "size": webp.len() })))
}

/// Shared delete: drop the stored bytes and clear the pointer so serving falls
/// back to the generated placeholder.
async fn delete_media(
    state: &AppState,
    user_id: Uuid,
    clan_id: Uuid,
    kind: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_clan_admin(state, user_id, clan_id).await?;

    sqlx::query("DELETE FROM clan_media WHERE clan_id = $1 AND kind = $2")
        .bind(clan_id)
        .bind(kind)
        .execute(&state.pool)
        .await
        .or_500()?;
    let col = pointer_column(kind);
    sqlx::query(&format!(
        "UPDATE clans SET {col} = NULL, updated_at = NOW() WHERE id = $1"
    ))
    .bind(clan_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({ "ok": true })))
}

/// Map a media kind to its pointer column on `clans`. Only ever called with the
/// two literals below, so it never actually hits the fallback.
fn pointer_column(kind: &str) -> &'static str {
    match kind {
        "banner" => "banner_url",
        _ => "avatar_url",
    }
}

/// Public serving with fallback. Reads the clan's pointer column: NULL (never
/// set, deleted, or moderation-locked) → generated placeholder; an external
/// `http(s)` pointer with no stored bytes → redirect; otherwise decode and
/// serve the stored WebP.
async fn serve_media(state: &AppState, clan_id: Uuid, kind: &str) -> Response {
    let col = pointer_column(kind);
    // Outer Option = clan row exists; inner Option = pointer value.
    let pointer: Option<Option<String>> =
        sqlx::query_scalar(&format!("SELECT {col} FROM clans WHERE id = $1"))
            .bind(clan_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

    if let Some(Some(ptr)) = pointer {
        // Custom media is present (and not taken down). Prefer stored bytes.
        let stored: Option<String> =
            sqlx::query_scalar("SELECT image FROM clan_media WHERE clan_id = $1 AND kind = $2")
                .bind(clan_id)
                .bind(kind)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
        if let Some((mime, bytes)) = stored.as_deref().and_then(decode_data_url) {
            return image_response(mime, bytes);
        }
        // Legacy/external pointer with no stored bytes → redirect to it.
        if ptr.starts_with("http://") || ptr.starts_with("https://") {
            return Redirect::temporary(&ptr).into_response();
        }
    }

    // Fallback — deterministic, seeded on the clan id, never 404.
    let seed = clan_id.to_string();
    let svg = if kind == "banner" {
        identicon::banner_svg(&seed, 960, 320)
    } else {
        identicon::identicon_svg(&seed, 256)
    };
    identicon::svg_response(svg)
}

// ── Route handlers ─────────────────────────────────────────────────────────

// POST /api/v3/clans/{id}/avatar
pub async fn upload_clan_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanMediaUpload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    upload_media(&state, auth.user_id, clan_id, "avatar", AVATAR_MAX_SIDE, body).await
}

// DELETE /api/v3/clans/{id}/avatar
pub async fn delete_clan_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    delete_media(&state, auth.user_id, clan_id, "avatar").await
}

// POST /api/v3/clans/{id}/banner
pub async fn upload_clan_banner(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanMediaUpload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    upload_media(&state, auth.user_id, clan_id, "banner", BANNER_MAX_SIDE, body).await
}

// DELETE /api/v3/clans/{id}/banner
pub async fn delete_clan_banner(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    delete_media(&state, auth.user_id, clan_id, "banner").await
}

// GET /api/v3/clans/{id}/avatar — public, never 404s.
pub async fn get_clan_avatar(Path(clan_id): Path<Uuid>, State(state): State<AppState>) -> Response {
    serve_media(&state, clan_id, "avatar").await
}

// GET /api/v3/clans/{id}/banner — public, never 404s.
pub async fn get_clan_banner(Path(clan_id): Path<Uuid>, State(state): State<AppState>) -> Response {
    serve_media(&state, clan_id, "banner").await
}
