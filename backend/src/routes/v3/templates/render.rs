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
use image::{ImageReader, RgbaImage};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Cursor;
use uuid::Uuid;

use crate::AppState;

use super::access::TemplateAccess;

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

// ---------------------------------------------------------------------------
// Sprite-sheet animation
//
// Slicing + timing math is ported verbatim from the frontend authority
// (src/formats/shared/sprite-sheet.ts). Do not "improve" the arithmetic here
// without also updating that module and its parity test.
// ---------------------------------------------------------------------------

/// Hard caps so a hostile document can't spin up a giant encode job.
const MAX_ANIM_FRAMES: usize = 256;
const MAX_FRAME_SIDE: u32 = 512;

/// Physical sheet layout for one animated layer.
struct AnimSheet {
    frame_width: u32,
    frame_height: u32,
    frame_count: usize,
    layout: String, // "line" | "grid"
    order: String,  // "row" | "column" | "serpentine"
}

/// Per-frame override: custom timing, skip flag, and optional replacement image.
struct FrameOverride {
    duration_ms: Option<u32>,
    skip: bool,
    image_sources: Vec<String>,
}

/// Parse `layer.animation.sheet` into an `AnimSheet`, or `None` when the layer
/// is static (no animation block, or a malformed one).
fn parse_anim_sheet(layer: &Value) -> Option<AnimSheet> {
    let sheet = layer.get("animation")?.get("sheet")?;
    let frame_width = sheet.get("frameWidth")?.as_u64()? as u32;
    let frame_height = sheet.get("frameHeight")?.as_u64()? as u32;
    let frame_count = sheet.get("frameCount")?.as_u64()? as usize;
    if frame_width == 0 || frame_height == 0 || frame_count == 0 {
        return None;
    }
    Some(AnimSheet {
        frame_width,
        frame_height,
        frame_count,
        layout: sheet
            .get("layout")
            .and_then(|v| v.as_str())
            .unwrap_or("grid")
            .to_string(),
        order: sheet
            .get("order")
            .and_then(|v| v.as_str())
            .unwrap_or("row")
            .to_string(),
    })
}

/// Default per-frame duration (ms) for the layer, floored at 1.
fn default_frame_ms(layer: &Value) -> u32 {
    layer
        .get("animation")
        .and_then(|a| a.get("timing"))
        .and_then(|t| t.get("defaultFrameMs"))
        .and_then(|v| v.as_f64())
        .map(|d| d.max(1.0) as u32)
        .unwrap_or(1000)
}

/// Whether the timeline loops (defaults to true — the common case).
fn is_looping(layer: &Value) -> bool {
    layer
        .get("animation")
        .and_then(|a| a.get("timing"))
        .and_then(|t| t.get("looping"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Collect per-frame overrides keyed by frame index.
fn parse_overrides(layer: &Value) -> HashMap<usize, FrameOverride> {
    let mut map = HashMap::new();
    let frames = layer
        .get("animation")
        .and_then(|a| a.get("timing"))
        .and_then(|t| t.get("frames"))
        .and_then(|v| v.as_array());
    if let Some(frames) = frames {
        for f in frames {
            let Some(index) = f.get("index").and_then(|v| v.as_u64()) else {
                continue;
            };
            let image_sources = f
                .get("imageSources")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.as_str().map(|s| s.to_string()))
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            map.insert(
                index as usize,
                FrameOverride {
                    duration_ms: f
                        .get("durationMs")
                        .and_then(|v| v.as_f64())
                        .map(|d| d.max(1.0) as u32),
                    skip: f.get("skip").and_then(|v| v.as_bool()).unwrap_or(false),
                    image_sources,
                },
            );
        }
    }
    map
}

/// Play-order timeline with skips removed and per-frame durations resolved.
/// Ported from `normalizeTiming` — returns `(frame_index, delay_ms)` pairs.
fn normalize_timing(sheet: &AnimSheet, default_ms: u32, overrides: &HashMap<usize, FrameOverride>) -> Vec<(usize, u32)> {
    let mut out = Vec::new();
    for i in 0..sheet.frame_count {
        let o = overrides.get(&i);
        if o.map(|o| o.skip).unwrap_or(false) {
            continue;
        }
        let d = o.and_then(|o| o.duration_ms).unwrap_or(default_ms);
        if d == 0 {
            continue;
        }
        out.push((i, d));
    }
    out
}

/// Sheet sub-rect of frame `index`, honouring layout + traversal order.
/// Ported verbatim from `frameRect` in sprite-sheet.ts.
fn frame_rect(index: usize, sheet: &AnimSheet, image_w: u32, image_h: u32) -> (u32, u32, u32, u32) {
    let fw = sheet.frame_width;
    let fh = sheet.frame_height;
    if sheet.layout == "line" {
        return (index as u32 * fw, 0, fw, fh);
    }
    let cols = ((image_w as f64 / fw as f64).round() as i64).max(1) as usize;
    let rows = ((image_h as f64 / fh as f64).round() as i64).max(1) as usize;
    let (gx, gy) = match sheet.order.as_str() {
        "column" => (index / rows, index % rows),
        "serpentine" => {
            let gy = index / cols;
            let in_row = index % cols;
            let gx = if gy % 2 == 0 {
                in_row
            } else {
                cols.saturating_sub(1).saturating_sub(in_row)
            };
            (gx, gy)
        }
        _ => (index % cols, index / cols), // row-major
    };
    (gx as u32 * fw, gy as u32 * fh, fw, fh)
}

/// Extract frame `index` from the decoded sheet as a standalone RGBA image.
/// Clamps to sheet bounds so an out-of-range grid cell yields transparency
/// rather than an error.
fn slice_frame(sheet_rgba: &RgbaImage, sheet: &AnimSheet, index: usize) -> RgbaImage {
    let (sx, sy, sw, sh) = frame_rect(index, sheet, sheet_rgba.width(), sheet_rgba.height());
    let mut frame = RgbaImage::new(sw.max(1), sh.max(1));
    let (iw, ih) = (sheet_rgba.width(), sheet_rgba.height());
    if sx < iw && sy < ih {
        let cw = sw.min(iw - sx);
        let ch = sh.min(ih - sy);
        let crop = image::imageops::crop_imm(sheet_rgba, sx, sy, cw, ch).to_image();
        image::imageops::replace(&mut frame, &crop, 0, 0);
    }
    frame
}

/// Fit an RGBA frame into a `side`×`side` box (nearest-neighbour, aspect kept).
/// `None` leaves the frame at native size.
fn fit_frame(frame: RgbaImage, side: Option<u32>) -> RgbaImage {
    let target = match side {
        Some(s) => s.min(MAX_FRAME_SIDE),
        None => return clamp_side(frame),
    };
    let (w, h) = (frame.width(), frame.height());
    if w == 0 || h == 0 {
        return frame;
    }
    let factor = (target as f64 / w.max(h) as f64).min(16.0);
    let nw = ((w as f64 * factor).round() as u32).max(1);
    let nh = ((h as f64 * factor).round() as u32).max(1);
    image::imageops::resize(&frame, nw, nh, image::imageops::FilterType::Nearest)
}

/// Cap a frame's longest side at `MAX_FRAME_SIDE` so native-size renders of a
/// huge sheet stay bounded.
fn clamp_side(frame: RgbaImage) -> RgbaImage {
    let (w, h) = (frame.width(), frame.height());
    if w.max(h) <= MAX_FRAME_SIDE || w == 0 || h == 0 {
        return frame;
    }
    let factor = MAX_FRAME_SIDE as f64 / w.max(h) as f64;
    let nw = ((w as f64 * factor).round() as u32).max(1);
    let nh = ((h as f64 * factor).round() as u32).max(1);
    image::imageops::resize(&frame, nw, nh, image::imageops::FilterType::Nearest)
}

/// Encode a list of `(frame, delay_ms)` into an animated GIF. `looping` sets an
/// infinite NETSCAPE loop; otherwise the GIF plays once.
fn encode_gif(frames: Vec<(RgbaImage, u32)>, looping: bool) -> Result<Vec<u8>, String> {
    use image::codecs::gif::{GifEncoder, Repeat};
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut out);
        if looping {
            encoder
                .set_repeat(Repeat::Infinite)
                .map_err(|e| format!("gif repeat: {e}"))?;
        }
        for (buf, delay_ms) in frames {
            let delay = image::Delay::from_numer_denom_ms(delay_ms.max(10), 1);
            let frame = image::Frame::from_parts(buf, 0, 0, delay);
            encoder
                .encode_frame(frame)
                .map_err(|e| format!("gif encode frame: {e}"))?;
        }
    }
    Ok(out)
}

/// Decode a sheet's raw bytes and slice frame 0 to PNG. When the layer is not
/// animated the bytes are returned unchanged. This keeps `/png` + `/preview`
/// showing a real still (frame 0) instead of the whole sprite sheet.
fn first_frame_png(raw: &[u8], layer: &Value) -> Result<Vec<u8>, String> {
    let Some(sheet) = parse_anim_sheet(layer) else {
        return Ok(raw.to_vec());
    };
    let img = ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| format!("guess format: {e}"))?
        .decode()
        .map_err(|e| format!("decode: {e}"))?;
    let sheet_rgba = img.to_rgba8();
    let frame0 = slice_frame(&sheet_rgba, &sheet, 0);
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(frame0)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(out)
}

fn gif_response(bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/gif")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header(header::CONTENT_DISPOSITION, "inline; filename=\"template.gif\"")
        .body(Body::from(bytes))
        .unwrap()
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
    access: TemplateAccess,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<PngQuery>,
) -> Response {
    let idx = q.layer.unwrap_or(0);

    let (_owner_id, _scope, _clan_id, _author, document, _version) =
        match load_visible(&state, &access.context, id).await {
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

    // For an animated layer, render frame 0 (a real still) rather than the
    // whole sprite sheet.
    let still = match first_frame_png(&raw, layer) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("png frame-0 slice failed for template {id} layer {idx}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let scale = scale_value(layer);
    let png = match encode_png(&still, scale) {
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
    access: TemplateAccess,
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
        match load_visible(&state, &access.context, id).await {
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

    // Animated layers preview their first frame, not the raw sheet.
    let still = match first_frame_png(&raw, layer) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("preview frame-0 slice failed for template {id} layer {idx}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let scale = scale_value(layer);
    let png = match encode_png(&still, scale) {
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

#[derive(Debug, Deserialize)]
pub struct AnimatedQuery {
    pub layer: Option<usize>,
    /// Fit each frame into `size`×`size` (nearest-neighbour). Native when absent.
    pub size: Option<u32>,
}

/// GET /api/v3/templates/{id}/animated?layer=0&size=128
///
/// Render an animated GIF of the requested layer's sprite-sheet animation,
/// honouring layout, traversal order, per-frame durations, skips, and per-frame
/// image overrides. Static layers (no animation block) fall back to a single
/// still PNG so the endpoint is always safe to point an `<img>` at.
pub async fn get_animated(
    access: TemplateAccess,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<AnimatedQuery>,
) -> Response {
    let idx = q.layer.unwrap_or(0);

    let (_owner_id, _scope, _clan_id, _author, document, _version) =
        match load_visible(&state, &access.context, id).await {
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
            tracing::warn!("animated load failed for template {id} layer {idx}: {e}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    // Static layer → serve a single still PNG rather than erroring.
    let sheet = match parse_anim_sheet(layer) {
        Some(s) => s,
        None => {
            return match encode_png(&raw, scale_value(layer)) {
                Ok(p) => png_response(p),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
        }
    };

    let sheet_rgba = match ImageReader::new(Cursor::new(&raw)).with_guessed_format() {
        Ok(reader) => match reader.decode() {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                tracing::warn!("animated decode failed for template {id} layer {idx}: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        },
        Err(e) => {
            tracing::warn!("animated format guess failed for template {id} layer {idx}: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let overrides = parse_overrides(layer);
    let mut timeline = normalize_timing(&sheet, default_frame_ms(layer), &overrides);
    if timeline.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    timeline.truncate(MAX_ANIM_FRAMES);

    // Pre-load any per-frame replacement images referenced by overrides.
    let mut replacements: HashMap<usize, RgbaImage> = HashMap::new();
    for (frame_idx, ov) in overrides.iter() {
        if ov.skip {
            continue;
        }
        if let Some(src) = ov.image_sources.first() {
            if let Ok(bytes) = load_source_bytes(src).await {
                if let Ok(reader) = ImageReader::new(Cursor::new(&bytes)).with_guessed_format() {
                    if let Ok(img) = reader.decode() {
                        let resized = image::imageops::resize(
                            &img.to_rgba8(),
                            sheet.frame_width,
                            sheet.frame_height,
                            image::imageops::FilterType::Nearest,
                        );
                        replacements.insert(*frame_idx, resized);
                    }
                }
            }
        }
    }

    let frames: Vec<(RgbaImage, u32)> = timeline
        .into_iter()
        .map(|(frame_idx, delay)| {
            let frame = match replacements.remove(&frame_idx) {
                Some(img) => img,
                None => slice_frame(&sheet_rgba, &sheet, frame_idx),
            };
            (fit_frame(frame, q.size), delay)
        })
        .collect();

    match encode_gif(frames, is_looping(layer)) {
        Ok(gif) => gif_response(gif),
        Err(e) => {
            tracing::warn!("gif encode failed for template {id} layer {idx}: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub fn public_base_url(config: &crate::config::AppConfig) -> String {
    config
        .public_base_url
        .as_deref()
        .unwrap_or("https://the-wall.vai-rice.space")
        .trim_end_matches('/')
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests — pin parity with the frontend sprite-sheet math
// (src/formats/shared/sprite-sheet.ts).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(layout: &str, order: &str) -> AnimSheet {
        AnimSheet {
            frame_width: 10,
            frame_height: 8,
            frame_count: 6,
            layout: layout.to_string(),
            order: order.to_string(),
        }
    }

    #[test]
    fn frame_rect_line() {
        // line layout ignores rows; frames run along X.
        assert_eq!(frame_rect(0, &sheet("line", "row"), 60, 8), (0, 0, 10, 8));
        assert_eq!(frame_rect(2, &sheet("line", "row"), 60, 8), (20, 0, 10, 8));
    }

    #[test]
    fn frame_rect_grid_row_major() {
        // 30x16 sheet => cols 3, rows 2.
        let s = sheet("grid", "row");
        assert_eq!(frame_rect(0, &s, 30, 16), (0, 0, 10, 8));
        assert_eq!(frame_rect(4, &s, 30, 16), (10, 8, 10, 8)); // gx=1, gy=1
    }

    #[test]
    fn frame_rect_grid_column_major() {
        let s = sheet("grid", "column");
        // cols 3, rows 2. index 4 => gx=4/2=2, gy=4%2=0.
        assert_eq!(frame_rect(4, &s, 30, 16), (20, 0, 10, 8));
    }

    #[test]
    fn frame_rect_serpentine() {
        let s = sheet("grid", "serpentine");
        // cols 3. index 3 => gy=1 (odd), inRow=0, gx=cols-1-0=2.
        assert_eq!(frame_rect(3, &s, 30, 16), (20, 8, 10, 8));
        // index 4 => gy=1, inRow=1, gx=3-1-1=1.
        assert_eq!(frame_rect(4, &s, 30, 16), (10, 8, 10, 8));
    }

    #[test]
    fn normalize_timing_skips_and_overrides() {
        let s = AnimSheet {
            frame_width: 10,
            frame_height: 8,
            frame_count: 4,
            layout: "grid".into(),
            order: "row".into(),
        };
        let mut overrides = HashMap::new();
        overrides.insert(
            1,
            FrameOverride { duration_ms: None, skip: true, image_sources: vec![] },
        );
        overrides.insert(
            2,
            FrameOverride { duration_ms: Some(250), skip: false, image_sources: vec![] },
        );
        let timeline = normalize_timing(&s, 100, &overrides);
        assert_eq!(timeline, vec![(0, 100), (2, 250), (3, 100)]);
    }
}
