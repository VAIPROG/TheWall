/// Decode a `the-wall-dev://` share link into a canonical `the-wall-dev/2`
/// document. The link payload is `base64({ x, y, src, scale? })`.
use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::image_dims::data_url_dims;

pub fn decode_share(
    share: &str,
    name: &str,
    author_id: Uuid,
    created_at: DateTime<Utc>,
) -> Result<Value, String> {
    // Strip the optional protocol prefix.
    let b64 = share.trim().strip_prefix("the-wall-dev://").unwrap_or(share.trim());

    // Try standard base64, then URL-safe (the extension uses btoa which is
    // standard, but be lenient).
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| general_purpose::URL_SAFE.decode(b64))
        .map_err(|e| format!("share: base64 decode failed: {e}"))?;

    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("share: JSON parse failed: {e}"))?;

    let x = payload["x"]
        .as_f64()
        .ok_or_else(|| "share: missing field 'x'".to_string())? as i64;
    let y = payload["y"]
        .as_f64()
        .ok_or_else(|| "share: missing field 'y'".to_string())? as i64;
    let src = payload["src"]
        .as_str()
        .ok_or_else(|| "share: missing field 'src'".to_string())?
        .to_owned();
    let scale = payload["scale"].as_f64().unwrap_or(1.0);

    let (width, height) = data_url_dims(&src).unwrap_or((0, 0));

    let created_str = created_at.to_rfc3339();
    let doc = json!({
        "format": "the-wall-dev/2",
        "createdAt": created_str,
        "editedAt": created_str,
        "author": { "id": author_id.to_string() },
        "templates": [{
            "name": name,
            "imageSources": [src],
            "x": x,
            "y": y,
            "scale": scale,
            "width": width,
            "height": height
        }]
    });

    Ok(doc)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use base64::{Engine as _, engine::general_purpose};
    use chrono::TimeZone;

    // Minimal 1×1 grayscale PNG — 67 bytes, correct CRC (generated with Node zlib).
    const PNG_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNoAAAAggCB2kUIOwAAAABJRU5ErkJggg==";

    fn make_share(x: i64, y: i64, src: &str, scale: Option<f64>) -> String {
        let mut payload = serde_json::json!({ "x": x, "y": y, "src": src });
        if let Some(s) = scale {
            payload["scale"] = serde_json::Value::from(s);
        }
        let json_str = serde_json::to_string(&payload).unwrap();
        let b64 = general_purpose::STANDARD.encode(json_str.as_bytes());
        format!("the-wall-dev://{b64}")
    }

    #[test]
    fn decode_share_basic() {
        let share = make_share(42, -7, PNG_1X1, Some(2.0));
        let author = Uuid::new_v4();
        let ts = Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap();

        let doc = decode_share(&share, "my template", author, ts).unwrap();

        assert_eq!(doc["format"], "the-wall-dev/2");
        let tpl = &doc["templates"][0];
        assert_eq!(tpl["x"], 42);
        assert_eq!(tpl["y"], -7);
        assert_eq!(tpl["scale"], 2.0);
        assert_eq!(tpl["imageSources"][0], PNG_1X1);
        // Dimensions decoded from the 1×1 PNG.
        assert_eq!(tpl["width"], 1);
        assert_eq!(tpl["height"], 1);
    }

    #[test]
    fn decode_share_no_scale_defaults_to_one() {
        let share = make_share(0, 0, PNG_1X1, None);
        let doc = decode_share(&share, "t", Uuid::new_v4(), Utc::now()).unwrap();
        assert_eq!(doc["templates"][0]["scale"], 1.0);
    }

    #[test]
    fn decode_share_without_prefix() {
        // Strip prefix before calling — still works.
        let share = make_share(1, 2, PNG_1X1, None);
        let raw = share.strip_prefix("the-wall-dev://").unwrap().to_string();
        let doc = decode_share(&raw, "t", Uuid::new_v4(), Utc::now()).unwrap();
        assert_eq!(doc["templates"][0]["x"], 1);
    }

    #[test]
    fn decode_share_bad_base64_returns_err() {
        let result = decode_share("the-wall-dev://not!!valid", "t", Uuid::new_v4(), Utc::now());
        assert!(result.is_err());
    }
}
