//! GET /api/v2/templates/{id}/preview?size=64|128|256
//! Public endpoint — no auth required.
//! Returns a WebP thumbnail, generating and caching it on first request.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use serde::Deserialize;
use std::io::Cursor;
use uuid::Uuid;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct PreviewQuery {
    pub size: Option<u32>,
}

fn validate_size(size: Option<u32>) -> Result<u32, ()> {
    match size.unwrap_or(128) {
        s @ (64 | 128 | 256) => Ok(s),
        _ => Err(()),
    }
}

/// Decode the template `share` field into raw image bytes.
///
/// Accepts the two formats clients produce:
///   - "the-wall-dev://<base64-of-JSON>" where the JSON has `{ x, y, scale, src }`
///     and `src` itself is a `data:image/...;base64,<bytes>` URL.
///   - "data:image/<mime>;base64,<bytes>"   (raw data URL)
fn decode_share(share: &str) -> Option<Vec<u8>> {
    // Inline helper: strip `data:image/...;base64,` prefix and decode.
    fn decode_data_url(s: &str) -> Option<Vec<u8>> {
        let rest = s.strip_prefix("data:image/")?;
        let b64 = rest.split_once(',')?.1;
        BASE64.decode(b64).ok()
    }

    if let Some(rest) = share.strip_prefix("the-wall-dev://") {
        // The base64 payload here is *not* an image — it's a UTF-8 JSON blob
        // whose `src` field is the data URL we actually want to render.
        let json_bytes = BASE64.decode(rest).ok()?;
        let json_str = std::str::from_utf8(&json_bytes).ok()?;
        let v: serde_json::Value = serde_json::from_str(json_str).ok()?;
        let data_url = v.get("src")?.as_str()?;
        return decode_data_url(data_url);
    }
    if share.starts_with("data:image/") {
        return decode_data_url(share);
    }
    None
}

fn encode_webp_nearest(bytes: &[u8], side: u32) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;
    let img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    let img = img.resize_exact(side, side, image::imageops::FilterType::Nearest);
    let rgba = img.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    let webp_data = encoder.encode(80.0);
    Ok(webp_data.to_vec())
}

fn webp_response(bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/webp")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(Body::from(bytes))
        .unwrap()
}

pub async fn get_preview(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
) -> Response {
    let size = match validate_size(q.size) {
        Ok(s) => s,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "size must be 64, 128, or 256").into_response();
        }
    };

    // 1. Check template_previews cache.
    #[derive(sqlx::FromRow)]
    struct PreviewRow {
        preview_64: Option<Vec<u8>>,
        preview_128: Option<Vec<u8>>,
        preview_256: Option<Vec<u8>>,
    }

    let cached = sqlx::query_as::<_, PreviewRow>(
        "SELECT preview_64, preview_128, preview_256 FROM template_previews WHERE template_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    if let Some(row) = cached {
        let col = match size {
            64 => row.preview_64,
            128 => row.preview_128,
            _ => row.preview_256,
        };
        if let Some(bytes) = col {
            return webp_response(bytes);
        }
    }

    // 2. Load the template share field.
    let share: Option<String> = sqlx::query_scalar("SELECT share FROM templates WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();

    let share = match share {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    // 3. Decode share to raw image bytes.
    let raw_bytes = match decode_share(&share) {
        Some(b) => b,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    // 4. Encode all three sizes.
    let (w64, w128, w256) = match (
        encode_webp_nearest(&raw_bytes, 64),
        encode_webp_nearest(&raw_bytes, 128),
        encode_webp_nearest(&raw_bytes, 256),
    ) {
        (Ok(a), Ok(b), Ok(c)) => (a, b, c),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    // 5. Persist to template_previews.
    sqlx::query(
        r#"INSERT INTO template_previews (template_id, preview_64, preview_128, preview_256)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (template_id) DO UPDATE
               SET preview_64  = EXCLUDED.preview_64,
                   preview_128 = EXCLUDED.preview_128,
                   preview_256 = EXCLUDED.preview_256"#,
    )
    .bind(id)
    .bind(&w64)
    .bind(&w128)
    .bind(&w256)
    .execute(&state.pool)
    .await
    .ok(); // best-effort; don't fail the request if insert fails

    // 6. Return the requested size.
    let result = match size {
        64 => w64,
        128 => w128,
        _ => w256,
    };
    webp_response(result)
}

/* ---------------------------------------------------------------------------
 * Full PNG endpoint
 *
 * GET /api/v2/templates/{id}/png
 *
 * Returns the template at native resolution as image/png. Useful for users
 * who want to feed our templates into Charity (which rejects data: URLs
 * and demands a real image URL).
 *
 * We do NOT cache the PNG in the DB the same way we do thumbnails — the
 * full image already exists inside the share payload, so an on-the-fly
 * decode + re-encode is cheap and avoids doubling our storage footprint.
 * Cache-Control directs intermediaries to keep it for an hour.
 * --------------------------------------------------------------------- */

fn png_response(bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header(
            header::CONTENT_DISPOSITION,
            "inline; filename=\"template.png\"",
        )
        .body(Body::from(bytes))
        .unwrap()
}

/// Re-encode the decoded share bytes as a PNG.
///
/// `scale` is the template's stored on-canvas multiplier (1.0 = native).
/// When > 1 we nearest-neighbor upsample so the served pixel dimensions
/// match what the recipient actually wants to draw — Charity has no
/// `scale` field of its own, so the resize has to land in the image.
/// Values < 1 are clamped to 1: downscaling pixel-art templates would
/// destroy palette accuracy, and our share format encodes the original
/// at native resolution either way.
fn encode_png(bytes: &[u8], scale: f64) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;
    let mut img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    if scale > 1.0 + 1e-6 {
        // Hard cap to keep a buggy stored scale from blowing up RAM.
        let factor = scale.min(20.0);
        let w = (img.width() as f64 * factor).round() as u32;
        let h = (img.height() as f64 * factor).round() as u32;
        if w > 0 && h > 0 {
            img = img.resize_exact(w, h, image::imageops::FilterType::Nearest);
        }
    }
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(out)
}

fn encode_png_native(bytes: &[u8]) -> Result<Vec<u8>, String> {
    encode_png(bytes, 1.0)
}

/// Native-only path retained for callers that don't know (or care) about
/// the template's stored scale — the `/preview` JPEG generators and the
/// `/json` endpoint use this so the embedded data URL stays at native
/// resolution. The Charity / `/png` paths use `encode_png` directly so
/// `scale` is honoured.
fn encode_png_scaled(bytes: &[u8], scale: f64) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;

    let mut img = reader.decode().map_err(|e| format!("decode: {e}"))?;

    if (scale - 1.0).abs() > 1e-6 {
        let factor = scale.clamp(0.1, 16.0);
        let new_width = (img.width() as f64 * factor).round() as u32;
        let new_height = (img.height() as f64 * factor).round() as u32;

        if new_width > 0 && new_height > 0 {
            img = img.resize_exact(new_width, new_height, image::imageops::FilterType::Nearest);
        }
    }

    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;

    Ok(out)
}

pub async fn get_png(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let cached: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT scaled_png FROM template_previews WHERE template_id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

    if let Some(png) = cached {
        return png_response(png);
    }

    let row: Option<(String, f64)> =
        sqlx::query_as("SELECT share, scale FROM templates WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

    let Some((share, scale)) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let Some(raw_bytes) = decode_share(&share) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let png = match encode_png_scaled(&raw_bytes, scale) {
        Ok(png) => png,
        Err(e) => {
            tracing::warn!("png encode failed for {id} (scale={scale}): {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let _ = sqlx::query(
        r#"INSERT INTO template_previews (template_id, scaled_png)
           VALUES ($1, $2)
           ON CONFLICT (template_id)
           DO UPDATE SET scaled_png = EXCLUDED.scaled_png"#,
    )
    .bind(id)
    .bind(&png)
    .execute(&state.pool)
    .await;

    png_response(png)
}

/* ---------------------------------------------------------------------------
 * Canonical the-wall-dev/1 JSON
 *
 * GET /api/v2/templates/{id}/json
 *
 * Returns the same schema the extension produces when a user clicks
 * "Save JSON" in the Share tab. Useful for:
 *
 *   - Third-party tools that want to consume our templates without learning
 *     the share:// scheme.
 *   - Charity-config exports that reference our backend instead of asking
 *     the user to host their own PNG.
 *
 * The image payload is embedded as a data URL so the JSON is fully self-
 * contained — no extra round trip needed once the document is in hand.
 * --------------------------------------------------------------------- */

#[derive(Debug, sqlx::FromRow)]
struct TemplateJsonRow {
    name: String,
    x: i32,
    y: i32,
    scale: f64,
    share: String,
    author: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
}

fn json_response(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "public, max-age=300")
        .body(Body::from(body))
        .unwrap()
}

/* ---------------------------------------------------------------------------
 * Public base URL helper
 *
 * Charity / cross-tool consumers need a fully-qualified URL for the
 * referenced PNG, not a relative path. We read `PUBLIC_BASE_URL` from the
 * env so the operator decides exactly what hostname goes out (matters when
 * the backend sits behind a reverse proxy that rewrites paths). When the
 * env var is missing we fall back to the request path style.
 * --------------------------------------------------------------------- */
fn public_base_url() -> String {
    std::env::var("PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "https://the-wall.vai-rice.space".to_string())
        .trim_end_matches('/')
        .to_string()
}

pub async fn get_json(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let row: Option<TemplateJsonRow> = sqlx::query_as::<_, TemplateJsonRow>(
        "SELECT name, x, y, scale, share, author, created_at FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    let Some(row) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(raw_bytes) = decode_share(&row.share) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // We always serve the image as PNG inside the JSON. The native source
    // bytes might be JPEG/WEBP — re-encoding gives consumers a single
    // predictable format and lets us strip metadata in one place.
    let png = match encode_png_native(&raw_bytes) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("png encode for json failed {id}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Decode just to learn the dimensions — cheap because we already have
    // the bytes warm.
    let (w, h) = match ImageReader::new(Cursor::new(&raw_bytes))
        .with_guessed_format()
        .and_then(|r| Ok(r.decode()))
    {
        Ok(Ok(img)) => {
            let img = img;
            (img.width() as i32, img.height() as i32)
        }
        _ => (0_i32, 0_i32),
    };
    let data_url = format!("data:image/png;base64,{}", BASE64.encode(&png));
    let payload = serde_json::json!({
        "format": "the-wall-dev/1",
        "version": env!("CARGO_PKG_VERSION"),
        "exported_at": row.created_at.to_rfc3339(),
        "author": row.author.as_ref().map(|u| serde_json::json!({ "username": u })),
        "template": {
            "name": row.name,
            "image_data_url": data_url,
            "x": row.x,
            "y": row.y,
            "scale": row.scale,
            "width": w,
            "height": h,
        }
    });
    json_response(payload.to_string())
}

/* ---------------------------------------------------------------------------
 * Canonical Charity-format config
 *
 * GET /api/v2/templates/{id}/charity
 *
 * Returns the template wrapped as a Charity config that points at our
 * `/v2/templates/{id}/png` URL instead of carrying a base64 image (Charity
 * rejects data: URLs).
 *
 * Mapping:
 *   - `faction`            ← author's username (or "anonymous" when unknown)
 *   - `contact`            ← same author (Charity uses it for "who do I ping
 *                            if this needs to come down?")
 *   - `templates[0].name`  ← template name
 *   - `templates[0].sources` ← [ "<public>/api/v2/templates/{id}/png" ]
 *   - `templates[0].x / y` ← template coords
 *
 * Animation fields (`frameWidth`, `frameHeight`, `frameCount`,
 * `secondsPerFrame`, `startTimestamp`, `looping`) are intentionally
 * OMITTED for static templates. Upstream Charity treats missing keys as
 * "no animation" defaults; emitting them with placeholder values polluted
 * every static template with bogus metadata. When animated templates land
 * (future release), the fields come back gated on a real animation flag.
 *
 * Scale: Charity has no native `scale` field — every template is
 * displayed 1:1 on the canvas. We honour the user's stored `scale` by
 * resizing the PNG the `/png` endpoint serves, so the Charity client
 * receives an image whose pixel dimensions already match the on-canvas
 * size. The config itself only carries coords.
 * --------------------------------------------------------------------- */
pub async fn get_charity(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let row: Option<TemplateJsonRow> = sqlx::query_as::<_, TemplateJsonRow>(
        "SELECT name, x, y, scale, share, author, created_at FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    let Some(row) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let author = row.author.as_deref().unwrap_or("anonymous");
    let png_url = format!("{}/api/v2/templates/{}/png", public_base_url(), id);
    let payload = serde_json::json!({
        "faction":  author,
        "contact":  author,
        "templates": [
            {
                "name":    row.name,
                "sources": [png_url],
                "x":       row.x,
                "y":       row.y,
                // Animation fields intentionally omitted for static
                // templates — Charity treats missing keys as defaults.
            }
        ],
        "whitelist": []
    });
    json_response(payload.to_string())
}

/* ---------------------------------------------------------------------------
 * Animated-template preview
 * ------------------------------------------------------------------------ */

/// GET /api/v2/animated/templates/{id}/preview?size=64|128|256
///
/// Same contract as the classic preview, sourced from the stored
/// the-wall-dev/1 envelope: the thumbnail shows the FIRST FRAME of the sheet
/// (cropped via the animation block) so boards don't render a confusing
/// whole-sheet contact print. No DB cache — the crop is cheap and the
/// response carries the same one-hour Cache-Control as the classic path.
pub async fn get_anim_preview(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
) -> Response {
    let size = match validate_size(q.size) {
        Ok(s) => s,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "size must be 64, 128, or 256").into_response();
        }
    };

    let config: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT config FROM anim_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let Some(config) = config else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let Some(data_url) = config
        .pointer("/template/image_data_url")
        .and_then(|v| v.as_str())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(b64) = data_url
        .strip_prefix("data:image/")
        .and_then(|rest| rest.split_once(',').map(|(_, b)| b))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = BASE64.decode(b64) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let Ok(reader) = ImageReader::new(Cursor::new(&bytes)).with_guessed_format() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(mut img) = reader.decode() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    // Crop to frame 0 when the envelope carries a sheet grid.
    let fw = config
        .pointer("/template/animation/sheet/frameWidth")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let fh = config
        .pointer("/template/animation/sheet/frameHeight")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if fw > 0 && fh > 0 && fw <= img.width() && fh <= img.height() {
        img = img.crop_imm(0, 0, fw, fh);
    }

    let rgba = img
        .resize_exact(size, size, image::imageops::FilterType::Nearest)
        .to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    webp_response(encoder.encode(80.0).to_vec())
}
