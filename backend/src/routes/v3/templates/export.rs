//! Export handlers for V3 templates.
//!
//! GET /api/v3/templates/{id}/wall-dev  — return the stored document JSON as-is.
//! GET /api/v3/templates/{id}/charity   — derive a Charity config from the document.
//!
//! Visibility for both mirrors `read::get`:
//!   owner  OR  (public AND approved)  OR  (clan member of the template's clan).

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
};

// ---------------------------------------------------------------------------
// Shared visibility helper
// ---------------------------------------------------------------------------

/// Load a template row restricted to the caller's visibility, returning
/// `(owner_id, scope, clan_id, author, document)` or a 404 error.
async fn load_visible(
    state: &AppState,
    user_id: Uuid,
    template_id: Uuid,
) -> Result<(Uuid, String, Option<Uuid>, Option<String>, Option<Value>), (StatusCode, String)> {
    let row: Option<(Uuid, String, Option<Uuid>, Option<String>, Option<Value>)> =
        sqlx::query_as(
            r#"SELECT user_id, scope, clan_id, author, document
                 FROM templates
                WHERE id = $2
                  AND (
                      user_id = $1
                      OR (scope = 'public' AND status = 'approved')
                      OR (scope = 'clan' AND clan_id IN (
                            SELECT clan_id FROM clan_memberships
                             WHERE user_id = $1 AND active = TRUE
                          ))
                  )"#,
        )
        .bind(user_id)
        .bind(template_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    row.ok_or((StatusCode::NOT_FOUND, "not found".into()))
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}/wall-dev
// ---------------------------------------------------------------------------

/// Return the stored `document` JSONB as-is (the-wall-dev/2 format).
/// Returns 409 CONFLICT if the document column is NULL (un-backfilled legacy row).
pub async fn wall_dev(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_owner_id, _scope, _clan_id, _author, document) =
        load_visible(&state, auth.user_id, id).await?;

    let doc = document.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "template not yet migrated to v2 format".to_string(),
        )
    })?;

    Ok(Json(doc))
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}/charity
// ---------------------------------------------------------------------------

/// Derive a Charity config from the stored the-wall-dev/2 document.
///
/// Projection rules (mirrors `src/formats/charity/encode.ts`):
///   Each `document.templates[]` layer → a CharityEntry:
///     { name, sources: layer.imageSources, x, y }
///   If `layer.animation` is present:
///     frameWidth/frameHeight from animation.sheet
///     frameCount from animation.sheet.frameCount
///     secondsPerFrame = animation.timing.defaultFrameMs / 1000
///     startTimestamp = animation.timing.startTime / 1000
///     looping = animation.timing.looping
///
/// Wrapped as:
///   { faction: "the-wall-dev export", contact: <author or "anonymous">,
///     templates: [...], whitelist: [] }
pub async fn charity(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (_owner_id, _scope, _clan_id, author, document) =
        load_visible(&state, auth.user_id, id).await?;

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

    let entries: Vec<Value> = layers.iter().map(layer_to_charity_entry).collect();

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

fn layer_to_charity_entry(layer: &Value) -> Value {
    let name = layer.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled");
    let sources = layer.get("imageSources").cloned().unwrap_or(json!([]));
    let x = layer.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = layer.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);

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
