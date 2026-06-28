/// Convert a `the-wall-dev/1` document into the canonical `the-wall-dev/2`
/// shape. Mirrors `src/formats/wall-dev/decode.ts` → `readV1`.
///
/// v1 → v2 mapping:
///   - `image_data_url` → `imageSources: [image_data_url]`
///   - `animation.scaling.mode` → `animation.scaleMode`
///   - `author.username` → `author.name`, `author.clan_name` → `author.clanName`
///   - `author.clan_role` DROPPED (obsolete)
///   - `note` (string) → `notes: [note]`
///   - `exported_at` → `createdAt` / `editedAt`
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Copy the animation block from v1 into v2 format.
/// v1 `scaling.mode` becomes top-level `scaleMode`.
/// `timing.frames` is copied verbatim (same FrameOverride shape in v1 & v2,
/// except v2 extends it — we forward only what v1 has).
fn map_v1_animation(anim: &Value) -> Value {
    let sheet = &anim["sheet"];
    let timing = &anim["timing"];

    let mut timing_out = json!({
        "startTime": timing["startTime"],
        "defaultFrameMs": timing["defaultFrameMs"],
        "looping": timing["looping"],
    });
    // Forward frames array if present.
    if let Some(frames) = timing["frames"].as_array() {
        let mapped: Vec<Value> = frames
            .iter()
            .map(|f| {
                let mut fo = Map::new();
                fo.insert("index".into(), f["index"].clone());
                if !f["durationMs"].is_null() && f["durationMs"] != Value::Null {
                    if let Some(v) = f.get("durationMs") {
                        if !v.is_null() {
                            fo.insert("durationMs".into(), v.clone());
                        }
                    }
                }
                if let Some(v) = f.get("skip") {
                    if !v.is_null() {
                        fo.insert("skip".into(), v.clone());
                    }
                }
                Value::Object(fo)
            })
            .collect();
        timing_out["frames"] = Value::Array(mapped);
    }

    let mut anim_out = json!({
        "sheet": {
            "frameWidth": sheet["frameWidth"],
            "frameHeight": sheet["frameHeight"],
            "frameCount": sheet["frameCount"],
            "layout": sheet["layout"],
            "order": sheet["order"],
        },
        "timing": timing_out,
    });

    // `scaling.mode` → `scaleMode`.
    if let Some(mode) = anim["scaling"]["mode"].as_str() {
        anim_out["scaleMode"] = Value::String(mode.to_owned());
    }

    anim_out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Convert a `the-wall-dev/1` JSON value to a `the-wall-dev/2` document.
///
/// `author_id` is the backend's canonical UUID for the importing user.
/// `created_at` is used for `createdAt` / `editedAt` when `exported_at` is
/// absent from the v1 payload.
pub fn v1_to_v2(
    v1: &Value,
    author_id: Uuid,
    created_at: DateTime<Utc>,
) -> Result<Value, String> {
    if v1["format"].as_str() != Some("the-wall-dev/1") {
        return Err(format!(
            "wall_dev::v1_to_v2: expected format 'the-wall-dev/1', got {:?}",
            v1["format"]
        ));
    }

    let t = &v1["template"];

    // Build the layer entry.
    let image_data_url = t["image_data_url"]
        .as_str()
        .ok_or_else(|| "wall_dev::v1_to_v2: missing template.image_data_url".to_string())?;

    let layer_name = t["name"].as_str().unwrap_or("(unnamed)");

    let mut layer = json!({
        "name": layer_name,
        "imageSources": [image_data_url],
        "x": t["x"],
        "y": t["y"],
        "scale": t["scale"],
        "width": t["width"],
        "height": t["height"],
    });

    if let Some(anim) = t.get("animation") {
        if !anim.is_null() {
            layer["animation"] = map_v1_animation(anim);
        }
    }

    // Author: pick up username / clan_name from v1; clan_role is dropped.
    let mut author_obj = json!({ "id": author_id.to_string() });
    if let Some(a) = v1.get("author") {
        if !a.is_null() {
            if let Some(username) = a["username"].as_str() {
                author_obj["name"] = Value::String(username.to_owned());
            }
            if let Some(clan) = a["clan_name"].as_str() {
                author_obj["clanName"] = Value::String(clan.to_owned());
            }
        }
    }

    // Timestamps: prefer exported_at from v1, fall back to created_at param.
    let ts = v1["exported_at"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| created_at.to_rfc3339());

    // Notes: forward the v1 `note` string as a one-element array.
    let mut notes: Vec<Value> = Vec::new();
    if let Some(note) = v1["note"].as_str() {
        if !note.is_empty() {
            notes.push(Value::String(note.to_owned()));
        }
    }

    let mut doc = json!({
        "format": "the-wall-dev/2",
        "createdAt": ts,
        "editedAt": ts,
        "author": author_obj,
        "templates": [layer],
    });

    if !notes.is_empty() {
        doc["notes"] = Value::Array(notes);
    }

    Ok(doc)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn author() -> Uuid {
        Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap()
    }

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap()
    }

    fn minimal_v1() -> Value {
        json!({
            "format": "the-wall-dev/1",
            "version": "5.0.0",
            "exported_at": "2024-06-01T12:00:00Z",
            "template": {
                "name": "test template",
                "image_data_url": "data:image/png;base64,abc123",
                "x": 100,
                "y": 200,
                "scale": 1.5,
                "width": 64,
                "height": 64
            }
        })
    }

    #[test]
    fn basic_fields_mapped() {
        let v1 = minimal_v1();
        let doc = v1_to_v2(&v1, author(), ts()).unwrap();

        assert_eq!(doc["format"], "the-wall-dev/2");
        assert_eq!(doc["createdAt"], "2024-06-01T12:00:00Z");

        let tpl = &doc["templates"][0];
        assert_eq!(tpl["name"], "test template");
        assert_eq!(tpl["imageSources"][0], "data:image/png;base64,abc123");
        assert_eq!(tpl["x"], 100);
        assert_eq!(tpl["y"], 200);
        assert_eq!(tpl["scale"], 1.5);
        assert_eq!(tpl["width"], 64);
        assert_eq!(tpl["height"], 64);
    }

    #[test]
    fn animation_scaling_mode_mapped() {
        let mut v1 = minimal_v1();
        v1["template"]["animation"] = json!({
            "sheet": {
                "frameWidth": 32,
                "frameHeight": 32,
                "frameCount": 4,
                "layout": "grid",
                "order": "row"
            },
            "timing": {
                "startTime": 0,
                "defaultFrameMs": 100,
                "looping": true
            },
            "scaling": { "mode": "native" }
        });

        let doc = v1_to_v2(&v1, author(), ts()).unwrap();
        let anim = &doc["templates"][0]["animation"];
        assert_eq!(anim["scaleMode"], "native");
        assert_eq!(anim["sheet"]["frameCount"], 4);
        assert_eq!(anim["timing"]["defaultFrameMs"], 100);
    }

    #[test]
    fn note_forwarded_to_notes_array() {
        let mut v1 = minimal_v1();
        v1["note"] = Value::String("important note".into());

        let doc = v1_to_v2(&v1, author(), ts()).unwrap();
        assert_eq!(doc["notes"][0], "important note");
    }

    #[test]
    fn author_username_and_clan_mapped() {
        let mut v1 = minimal_v1();
        v1["author"] = json!({
            "username": "alice",
            "clan_name": "The Painters",
            "clan_role": "member"  // must be dropped
        });

        let doc = v1_to_v2(&v1, author(), ts()).unwrap();
        let auth = &doc["author"];
        assert_eq!(auth["name"], "alice");
        assert_eq!(auth["clanName"], "The Painters");
        assert!(auth.get("clan_role").is_none(), "clan_role must be dropped");
        assert_eq!(auth["id"], "11111111-1111-1111-1111-111111111111");
    }

    #[test]
    fn exported_at_absent_uses_created_at_param() {
        let mut v1 = minimal_v1();
        v1["exported_at"] = Value::Null;

        let doc = v1_to_v2(&v1, author(), ts()).unwrap();
        // Should fall back to the passed-in created_at.
        let created = doc["createdAt"].as_str().unwrap();
        assert!(created.contains("2024-06-01"));
    }

    #[test]
    fn wrong_format_returns_err() {
        let bad = json!({ "format": "charity", "templates": [] });
        assert!(v1_to_v2(&bad, author(), ts()).is_err());
    }
}
