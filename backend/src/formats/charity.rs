/// Convert a Charity config JSON to a canonical `the-wall-dev/2` document.
/// Mirrors `src/formats/charity/decode.ts` exactly.
///
/// Returns `(document, warnings)` so the caller can surface non-fatal issues
/// (unknown dimensions, recovered interop tags) without dropping the import.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Interop-tag helpers  (mirrors interop-tag.ts)
//
// Tag format: `(TheWallDev: ID:<id>[;BACKEND:<url>])`
// We implement this with plain string scanning rather than pulling in the
// `regex` crate, which isn't listed in Cargo.toml.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct InteropTag {
    id: String,
    backend_url: Option<String>,
}

/// Find and parse `(TheWallDev: ID:<id>;BACKEND:<url>)` inside `text`.
/// Returns `None` when the tag is absent or malformed.
fn parse_interop_tag(text: &str) -> Option<InteropTag> {
    // Locate the opening marker.
    let open = text.find("(TheWallDev:")?;
    let rest = &text[open + "(TheWallDev:".len()..];

    // Skip optional whitespace.
    let rest = rest.trim_start();

    // Expect "ID:".
    let rest = rest.strip_prefix("ID:")?;

    // The id runs until ';', ')' or whitespace.
    let id_end = rest.find(|c: char| c == ';' || c == ')' || c.is_whitespace())?;
    let id = &rest[..id_end];
    if id.is_empty() {
        return None;
    }
    let after_id = &rest[id_end..];

    // Optional BACKEND segment.
    let backend_url = if after_id.starts_with(';') {
        let after_semi = &after_id[1..];
        if let Some(url_part) = after_semi.strip_prefix("BACKEND:") {
            // URL runs until ')'.
            let url_end = url_part.find(')')?;
            let url = url_part[..url_end].trim();
            if url.is_empty() {
                None
            } else {
                Some(url.to_owned())
            }
        } else {
            None
        }
    } else {
        None
    };

    Some(InteropTag {
        id: id.to_owned(),
        backend_url,
    })
}

/// Remove the interop tag from `text` and collapse runs of whitespace to one.
/// Matches `stripInteropTag` in interop-tag.ts.
fn strip_interop_tag(text: &str) -> String {
    // Find the tag boundaries.
    let Some(open) = text.find("(TheWallDev:") else {
        return text.to_owned();
    };
    // Walk forward to find the closing ')'.
    let Some(close_rel) = text[open..].find(')') else {
        return text.to_owned();
    };
    let close = open + close_rel + 1; // exclusive end

    let without = format!("{}{}", &text[..open], &text[close..]);
    // Collapse whitespace.
    without
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Convert a Charity config `cfg` into a `the-wall-dev/2` document.
///
/// Returns `(document, warnings)`.
pub fn charity_to_v2(
    cfg: &Value,
    author_id: Uuid,
    created_at: DateTime<Utc>,
) -> Result<(Value, Vec<String>), String> {
    let entries = cfg["templates"]
        .as_array()
        .ok_or_else(|| "charity: missing templates[]".to_string())?;

    let mut layers: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut tag_note: Option<String> = None;

    for entry in entries {
        // Skip entries without coordinates.
        if entry["x"].as_f64().is_none() || entry["y"].as_f64().is_none() {
            continue;
        }

        // Validate sources.
        let sources: Vec<String> = entry["sources"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if sources.is_empty() {
            continue;
        }

        // Parse the name — strip interop tag and recover author identity.
        let raw_name = entry["name"]
            .as_str()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let raw_name = if raw_name.is_empty() {
            "(unnamed)".to_string()
        } else {
            raw_name
        };

        // Look for interop tag on the first tagged entry only.
        if tag_note.is_none() {
            if let Some(tag) = parse_interop_tag(&raw_name) {
                let note = format!(
                    "recovered TheWallDev origin id={}{}",
                    tag.id,
                    tag.backend_url
                        .as_deref()
                        .map(|u| format!(" backend={u}"))
                        .unwrap_or_default()
                );
                warnings.push(note.clone());
                tag_note = Some(note);
            }
        }

        let visible_name = {
            let stripped = strip_interop_tag(&raw_name).trim().to_string();
            if stripped.is_empty() {
                "(unnamed)".to_string()
            } else {
                stripped
            }
        };

        let frame_count = entry["frameCount"].as_f64().unwrap_or(1.0) as u64;
        let frame_width = entry["frameWidth"].as_f64().unwrap_or(0.0) as u64;
        let frame_height = entry["frameHeight"].as_f64().unwrap_or(0.0) as u64;
        let x = entry["x"].as_f64().unwrap().round() as i64;
        let y = entry["y"].as_f64().unwrap().round() as i64;

        // Dimension warning: Charity sources are remote URLs.
        if frame_width == 0 || frame_height == 0 {
            warnings.push(format!(
                "image dimensions unknown for layer '{}' \
                 (Charity sources are URLs; dimensions resolve on client render)",
                visible_name
            ));
        }

        let image_sources: Vec<Value> = sources.iter().map(|s| Value::String(s.clone())).collect();

        let mut layer = json!({
            "name": visible_name,
            "imageSources": image_sources,
            "x": x,
            "y": y,
            "scale": 1.0,
            "width": frame_width,
            "height": frame_height,
        });

        // Animation block when frameCount > 1.
        if frame_count > 1 {
            let seconds_per_frame = entry["secondsPerFrame"]
                .as_f64()
                .or_else(|| entry["frameRate"].as_f64())
                .or_else(|| entry["frameSpeed"].as_f64())
                .unwrap_or(1.0);

            let start_seconds = entry["startTimestamp"]
                .as_f64()
                .or_else(|| entry["startTime"].as_f64())
                .unwrap_or(0.0);

            let start_time_ms = (start_seconds * 1000.0).round() as i64;
            let default_frame_ms = (seconds_per_frame * 1000.0).round().max(1.0) as i64;

            let looping = entry["looping"].as_bool().unwrap_or(true);

            layer["animation"] = json!({
                "sheet": {
                    "frameWidth": frame_width,
                    "frameHeight": frame_height,
                    "frameCount": frame_count,
                    "layout": "grid",
                    "order": "row",
                },
                "timing": {
                    "startTime": start_time_ms,
                    "defaultFrameMs": default_frame_ms,
                    "looping": looping,
                },
                "scaleMode": "native",
            });
        }

        layers.push(layer);
    }

    if layers.is_empty() {
        return Err("charity: no usable templates (need x/y/sources)".to_string());
    }

    let created_str = created_at.to_rfc3339();

    // Build notes: faction line + optional tag note.
    let mut notes: Vec<Value> = Vec::new();
    if let Some(faction) = cfg["faction"].as_str() {
        if !faction.is_empty() {
            notes.push(Value::String(format!("faction: {faction}")));
        }
    }
    if let Some(note) = tag_note {
        notes.push(Value::String(note));
    }

    let mut doc = json!({
        "format": "the-wall-dev/2",
        "createdAt": created_str,
        "editedAt": created_str,
        "author": { "id": author_id.to_string() },
        "templates": layers,
    });

    if !notes.is_empty() {
        doc["notes"] = Value::Array(notes);
    }

    Ok((doc, warnings))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn author() -> Uuid {
        Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap()
    }

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap()
    }

    #[test]
    fn two_entries_static_and_animated() {
        let cfg = json!({
            "templates": [
                {
                    "name": "animated layer",
                    "sources": ["https://example.com/anim.png"],
                    "x": 10.7,
                    "y": -3.2,
                    "frameWidth": 32,
                    "frameHeight": 32,
                    "frameCount": 4,
                    "secondsPerFrame": 0.5,
                    "startTimestamp": 2.0,
                    "looping": true
                },
                {
                    "name": "static layer",
                    "sources": ["https://example.com/static.png"],
                    "x": 100,
                    "y": 200
                }
            ]
        });

        let (doc, warnings) = charity_to_v2(&cfg, author(), ts()).unwrap();

        // Two layers produced.
        let templates = doc["templates"].as_array().unwrap();
        assert_eq!(templates.len(), 2);

        // --- Animated layer ---
        let anim_layer = &templates[0];
        assert_eq!(anim_layer["name"], "animated layer");
        assert_eq!(anim_layer["x"], 11); // round(10.7)
        assert_eq!(anim_layer["y"], -3); // round(-3.2)
        assert_eq!(anim_layer["scale"], 1.0);

        let anim = &anim_layer["animation"];
        assert_eq!(anim["sheet"]["frameCount"], 4);
        assert_eq!(anim["sheet"]["layout"], "grid");
        assert_eq!(anim["sheet"]["order"], "row");
        assert_eq!(anim["timing"]["defaultFrameMs"], 500); // 0.5 * 1000
        assert_eq!(anim["timing"]["startTime"], 2000);     // 2.0 * 1000
        assert_eq!(anim["timing"]["looping"], true);
        assert_eq!(anim["scaleMode"], "native");

        // --- Static layer ---
        let static_layer = &templates[1];
        assert_eq!(static_layer["name"], "static layer");
        // No animation key present on static layer.
        assert!(
            !static_layer.as_object().unwrap().contains_key("animation"),
            "static layer must not have animation"
        );

        // Warnings: static layer has unknown dims (no frameWidth/frameHeight).
        // Animated layer has explicit frameWidth=32, frameHeight=32 so no warning for it.
        assert!(!warnings.is_empty(), "expected dimension warnings");
        assert!(
            warnings.iter().any(|w| w.contains("static layer")),
            "expected warning for static layer, got: {:?}", warnings
        );
    }

    #[test]
    fn interop_tag_stripped_from_name_and_warning_emitted() {
        let tag = "(TheWallDev: ID:deadbeef-dead-dead-dead-deaddeadbeef;BACKEND:https://api.example.com)";
        let cfg = json!({
            "templates": [{
                "name": format!("My Clan {tag}"),
                "sources": ["https://example.com/img.png"],
                "x": 0,
                "y": 0
            }]
        });

        let (doc, warnings) = charity_to_v2(&cfg, author(), ts()).unwrap();

        // Name should have the tag stripped.
        assert_eq!(doc["templates"][0]["name"], "My Clan");

        // Warning should mention the recovered id.
        assert!(
            warnings.iter().any(|w| w.contains("deadbeef-dead-dead-dead-deaddeadbeef")),
            "expected interop tag warning, got: {:?}",
            warnings
        );
    }

    #[test]
    fn faction_becomes_note() {
        let cfg = json!({
            "faction": "Blue Team",
            "templates": [{
                "sources": ["https://example.com/img.png"],
                "x": 0,
                "y": 0
            }]
        });

        let (doc, _) = charity_to_v2(&cfg, author(), ts()).unwrap();
        let notes = doc["notes"].as_array().unwrap();
        assert!(notes.iter().any(|n| n.as_str() == Some("faction: Blue Team")));
    }

    #[test]
    fn entry_without_sources_skipped() {
        let cfg = json!({
            "templates": [
                { "sources": [], "x": 0, "y": 0 },
                { "sources": ["https://example.com/ok.png"], "x": 1, "y": 1 }
            ]
        });
        let (doc, _) = charity_to_v2(&cfg, author(), ts()).unwrap();
        assert_eq!(doc["templates"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn all_entries_invalid_returns_err() {
        let cfg = json!({ "templates": [{ "sources": [], "x": 0, "y": 0 }] });
        assert!(charity_to_v2(&cfg, author(), ts()).is_err());
    }

    #[test]
    fn seconds_per_frame_aliases() {
        let make_cfg = |field: &str, value: f64| {
            let mut entry = json!({
                "name": "a",
                "sources": ["https://example.com/img.png"],
                "x": 0, "y": 0,
                "frameCount": 2
            });
            entry[field] = json!(value);
            json!({ "templates": [entry] })
        };

        let (doc, _) = charity_to_v2(&make_cfg("frameRate", 0.25), author(), ts()).unwrap();
        assert_eq!(doc["templates"][0]["animation"]["timing"]["defaultFrameMs"], 250);

        let (doc2, _) = charity_to_v2(&make_cfg("frameSpeed", 2.0), author(), ts()).unwrap();
        assert_eq!(doc2["templates"][0]["animation"]["timing"]["defaultFrameMs"], 2000);
    }

    #[test]
    fn parse_interop_tag_basic() {
        let tag = parse_interop_tag("(TheWallDev: ID:abc-123;BACKEND:https://api.example.com)");
        let tag = tag.unwrap();
        assert_eq!(tag.id, "abc-123");
        assert_eq!(tag.backend_url.as_deref(), Some("https://api.example.com"));
    }

    #[test]
    fn parse_interop_tag_no_backend() {
        let tag = parse_interop_tag("(TheWallDev: ID:only-id)");
        let tag = tag.unwrap();
        assert_eq!(tag.id, "only-id");
        assert!(tag.backend_url.is_none());
    }

    #[test]
    fn strip_interop_tag_removes_and_collapses() {
        let result = strip_interop_tag("My Clan (TheWallDev: ID:abc;BACKEND:https://x.example) extra");
        assert_eq!(result, "My Clan extra");
    }
}
