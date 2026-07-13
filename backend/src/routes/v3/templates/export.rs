//! Export handlers for V3 templates.
//!
//! GET /api/v3/templates/{id}/wall-dev  — return the stored document JSON as-is.
//! GET /api/v3/templates/{id}/charity   — derive a Charity config from the document.
//!
//! Visibility for both mirrors `read::get`:
//!   owner  OR  (public AND approved)  OR  (clan member of the template's clan).
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
};

// ---------------------------------------------------------------------------
// Shared visibility helper
// ---------------------------------------------------------------------------

/// Load a template row restricted to the caller's access context.
/// Returns `(owner_id, scope, clan_id, author, document, version)` or a 404 error.
pub async fn load_visible(
    state: &AppState,
    access: &super::access::AccessContext,
    template_id: Uuid,
) -> Result<(Uuid, String, Option<Uuid>, Option<String>, Option<Value>, i32), (StatusCode, String)>
{
    let user_id = access.user_id;

    // Full visibility (scope + whitelist/blocklist + co-editors). Shared by
    // render (preview/png/animated) and export. `$2` = the caller's user id.
    // Global staff bypass the blocklist/whitelist entirely.
    let privileged = super::acl::is_privileged(&state.pool, user_id).await;
    let visibility = super::acl::view_sql(2, privileged);
    let row: Option<(Uuid, String, Option<Uuid>, Option<String>, Option<Value>, i32)> =
        sqlx::query_as(&format!(
            r#"SELECT user_id, scope, clan_id, author, document, version
                 FROM templates
                WHERE id = $1 AND {visibility}"#
        ))
        .bind(template_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?;

    if let Some(row) = row {
        return Ok(row);
    }

    // If not found by normal visibility, try the per-template password.
    if let Some(password) = access.password.as_deref() {
        if super::access::verify_template_password(&state.pool, template_id, password).await {
            let row: Option<(Uuid, String, Option<Uuid>, Option<String>, Option<Value>, i32)> =
                sqlx::query_as(
                    "SELECT user_id, scope, clan_id, author, document, version FROM templates WHERE id = $1",
                )
                .bind(template_id)
                .fetch_optional(&state.pool)
                .await
                .or_500()?;
            return row.ok_or((StatusCode::NOT_FOUND, "not found".into()));
        }
    }

    Err((StatusCode::NOT_FOUND, "not found".into()))
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}/wall-dev
// ---------------------------------------------------------------------------

/// Return the stored `document` JSONB as-is (the-wall-dev/2 format).
/// Returns 409 CONFLICT if the document column is NULL (un-backfilled legacy row).
pub async fn wall_dev(
    access: super::access::TemplateAccess,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let (_owner_id, _scope, _clan_id, _author, document, version) =
        load_visible(&state, &access.context, id).await?;

    let doc = document.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "template not yet migrated to v2 format".to_string(),
        )
    })?;

    // ETag: "<id>-v<version>"
    let etag_value = format!("\"{}-v{}\"", id, version);

    // Conditional GET — return 304 if client already has this version.
    if let Some(inm) = headers.get("if-none-match") {
        if inm.as_bytes() == etag_value.as_bytes() {
            let mut resp_headers = HeaderMap::new();
            resp_headers.insert(
                "etag",
                HeaderValue::from_str(&etag_value)
                    .unwrap_or_else(|_| HeaderValue::from_static("")),
            );
            return Ok((StatusCode::NOT_MODIFIED, resp_headers).into_response());
        }
    }

    let mut resp_headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&etag_value) {
        resp_headers.insert("etag", v);
    }
    resp_headers.insert(
        "cache-control",
        HeaderValue::from_static("private, must-revalidate"),
    );

    Ok((StatusCode::OK, resp_headers, Json(doc)).into_response())
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}/charity
// ---------------------------------------------------------------------------

/// Derive a Charity config from the stored the-wall-dev/2 document.
///
/// Projection rules (mirrors `src/formats/charity/encode.ts`):
///   Each `document.templates[]` layer → a CharityEntry:
///     { name, sources: layer.imageSources + backend /png URL, x, y }
///   If `layer.animation` is present:
///     frameWidth/frameHeight from animation.sheet
///     frameCount from animation.sheet.frameCount
///     secondsPerFrame = animation.timing.defaultFrameMs / 1000
///     startTimestamp = animation.timing.startTime / 1000
///     looping = animation.timing.looping
///
/// The backend /png URL is always injected as the first source because Charity
/// cannot consume data: URLs and has no native scale field; the /png endpoint
/// bakes the layer's scale into the rendered image.
///
/// Wrapped as:
///   { faction: "the-wall-dev export", contact: <author or "anonymous">,
///     templates: [...], whitelist: [] }
pub async fn charity(
    access: super::access::TemplateAccess,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_owner_id, _scope, _clan_id, author, document, _version) =
        load_visible(&state, &access.context, id).await?;

    let doc = document.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "template not yet migrated to v2 format".to_string(),
        )
    })?;

    let layers = doc
        .get("templates")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "document.templates[] is missing or not an array".to_string(),
            )
        })?;

    let base_url = super::render::public_base_url(&state.config);
    let entries: Vec<Value> = layers
        .iter()
        .enumerate()
        .map(|(idx, layer)| layer_to_charity_entry(layer, id, idx, &base_url))
        .collect();

    let contact = author
        .filter(|a| !a.trim().is_empty())
        .unwrap_or_else(|| "anonymous".to_string());

    let config = json!({
        "faction": "the-wall-dev export",
        "contact": contact,
        "templates": entries,
        "whitelist": []
    });

    Ok(Json(config))
}

// ---------------------------------------------------------------------------
// Projection helper
// ---------------------------------------------------------------------------

fn layer_to_charity_entry(layer: &Value, template_id: Uuid, layer_idx: usize, base_url: &str) -> Value {
    let name = layer.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled");
    let x = layer.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = layer.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let mut sources = layer
        .get("imageSources")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    // Prepend the backend-rendered PNG URL so Charity always has a real image URL.
    let png_url = format!("{}/api/v3/templates/{}/png?layer={}", base_url, template_id, layer_idx);
    sources.insert(0, Value::String(png_url));

    let mut entry = json!({
        "name": name,
        "sources": sources,
        "x": x,
        "y": y,
    });

    // Animation fields — only included when an animation block is present.
    if let Some(anim) = layer.get("animation") {
        let sheet = anim.get("sheet");
        let timing = anim.get("timing");

        let frame_width = sheet.and_then(|s| s.get("frameWidth")).cloned();
        let frame_height = sheet.and_then(|s| s.get("frameHeight")).cloned();
        let frame_count = sheet.and_then(|s| s.get("frameCount")).cloned();

        let seconds_per_frame = timing
            .and_then(|t| t.get("defaultFrameMs"))
            .and_then(|v| v.as_f64())
            .map(|ms| ms / 1000.0);

        let start_timestamp = timing
            .and_then(|t| t.get("startTime"))
            .and_then(|v| v.as_f64())
            .map(|ms| ms / 1000.0);

        let looping = timing.and_then(|t| t.get("looping")).cloned();

        let obj = entry.as_object_mut().expect("entry is always an object");
        if let Some(v) = frame_width {
            obj.insert("frameWidth".to_string(), v);
        }
        if let Some(v) = frame_height {
            obj.insert("frameHeight".to_string(), v);
        }
        if let Some(v) = frame_count {
            obj.insert("frameCount".to_string(), v);
        }
        if let Some(v) = seconds_per_frame {
            obj.insert("secondsPerFrame".to_string(), json!(v));
        }
        if let Some(v) = start_timestamp {
            obj.insert("startTimestamp".to_string(), json!(v));
        }
        if let Some(v) = looping {
            obj.insert("looping".to_string(), v);
        }
    }

    entry
}
