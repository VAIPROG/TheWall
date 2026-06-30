//! GET /api/v3/templates/{id}/png
//! GET /api/v3/templates/{id}/preview?size=64|128|256&layer=0
//!
//! Public-ish endpoints (auth required, visibility restricted) that render a
//! single layer from a stored the-wall-dev/2 document as a real image. Used by
//! third-party consumers such as Charity, which cannot embed data: URLs and has
//! no native `scale` field — the served PNG is pre-scaled to the layer's
//! requested on-canvas size.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::ImageReader;
use serde::Deserialize;
use serde_json::Value;
use std::io::Cursor;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

use super::export::load_visible;

#[derive(Debug, Deserialize)]
pub struct PngQuery {
    pub layer: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct PreviewQuery {
    pub size: Option<u32>,
    pub layer: Option<usize>,
}

fn validate_size(size: Option<u32>) -> Result<u32, ()> {
    match size.unwrap_or(128) {
        s @ (64 | 128 | 256) => Ok(s),
        _ => Err(()),
    }
}

/// Decode a data:image/...;base64 URL into raw bytes.
fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:image/")?;
    let b64 = rest.split_once(',')?.1;
    BASE64.decode(b64).ok()
}

/// Load the first usable image source for a layer. Accepts both data URLs and
/// remote HTTP(S) URLs. For remote URLs we fetch with a short timeout.
async fn load_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    if source.starts_with("data:image/") {
        return decode_data_url(source)
            .ok_or_else(|| "failed to decode data URL".to_string());
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let bytes = client
            .get(source)
            .send()
            .await
            .map_err(|e| format!("fetch image: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("read image: {e}"))?;
        return Ok(bytes.to_vec());
    }

    Err(format!("unsupported image source scheme: {source}"))
}

/// Extract the requested layer from the document, returning a reference to the
/// layer object and its index.
fn get_layer<'a>(document: &'a Value, idx: usize) -> Result<&'a Value, String> {
    let layers = document
        .get("templates")
        .and_then(|v| v.as_array())
        .ok_or("document.templates[] missing")?;
    layers.get(idx).ok_or_else(|| format!("layer {idx} not found"))
}

/// Return the first non-empty image source from a layer.
fn first_source(layer: &Value) -> Option<String> {
    layer
        .get("imageSources")
        .and_then(|v| v.as_array())?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .find(|s| !s.is_empty())
}

fn scale_value(layer: &Value) -> f64 {
    layer
        .get("scale")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
}

/// Decode raw bytes to an image, optionally scale it, then encode as PNG.
fn encode_png(bytes: &[u8], scale: f64) -> Result<Vec<u8>, String> {
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

fn png_response(bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header(header::CONTENT_DISPOSITION, "inline; filename=\"template.png\"")
        .body(Body::from(bytes))
        .unwrap()
}

fn encode_webp(bytes: &[u8], side: u32) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?;
    let img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    let img = img.resize_exact(side, side, image::imageops::FilterType::Nearest);
    let rgba = img.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    Ok(encoder.encode(80.0).to_vec())
}

fn webp_response(bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/webp")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(Body::from(bytes))
        .unwrap()
}

/// GET /api/v3/templates/{id}/png
///
/// Render the requested layer as a PNG. If the layer has a `scale` value, the
/// output dimensions are multiplied by that factor (Charity has no native
/// scale, so the resize must happen server-side). Defaults to layer 0.
pub async fn get_png(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PngQuery>,
) -> Response {
    let idx = q.layer.unwrap_or(0);

    let (_owner_id, _scope, _clan_id, _author, document, _version) =
        match load_visible(&state, auth.user_id, id).await {
            Ok(r) => r,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };

    let document = match document {
        Some(d) => d,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let layer = match get_layer(&document, idx) {
        Ok(l) => l,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    let source = match first_source(layer) {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let raw = match load_source_bytes(&source).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("png load failed for template {id} layer {idx}: {e}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    let scale = scale_value(layer);
    let png = match encode_png(&raw, scale) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("png encode failed for template {id} layer {idx} (scale={scale}): {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    png_response(png)
}

/// GET /api/v3/templates/{id}/preview?size=64|128|256&layer=0
///
/// Return a square WebP thumbnail of the requested layer. Defaults to layer 0
/// and size 128. The preview is rendered at the layer's scale so the thumbnail
/// reflects the actual on-canvas appearance.
pub async fn get_preview(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
) -> Response {
    let size = match validate_size(q.size) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "size must be 64, 128, or 256").into_response(),
    };
    let idx = q.layer.unwrap_or(0);

    let (_owner_id, _scope, _clan_id, _author, document, _version) =
        match load_visible(&state, auth.user_id, id).await {
            Ok(r) => r,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };

    let document = match document {
        Some(d) => d,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let layer = match get_layer(&document, idx) {
        Ok(l) => l,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };

    let source = match first_source(layer) {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let raw = match load_source_bytes(&source).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("preview load failed for template {id} layer {idx}: {e}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    let scale = scale_value(layer);
    let png = match encode_png(&raw, scale) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("preview png encode failed for template {id} layer {idx}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let webp = match encode_webp(&png, size) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("preview webp encode failed for template {id} layer {idx}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    webp_response(webp)
}

pub fn public_base_url(config: &crate::config::AppConfig) -> String {
    config
        .public_base_url
        .as_deref()
        .unwrap_or("https://the-wall.vai-rice.space")
        .trim_end_matches('/')
        .to_string()
}
