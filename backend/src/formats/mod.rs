pub mod charity;
pub mod image_dims;
pub mod share;
pub mod wall_dev;

pub use share::decode_share;

use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

pub struct Converted {
    pub document: Value,
    pub warnings: Vec<String>,
}

/// Dispatch a payload to the correct format converter and return a canonical
/// `the-wall-dev/2` document plus any non-fatal warnings.
///
/// Accepted `source_format` values:
/// - `"the-wall-dev/2"` — passthrough after validating `templates` array.
/// - `"the-wall-dev/1"` — convert via `wall_dev::v1_to_v2`.
/// - `"charity"`        — convert via `charity::charity_to_v2`.
pub fn to_v2(
    source_format: &str,
    payload: &Value,
    author_id: Uuid,
    created_at: DateTime<Utc>,
) -> Result<Converted, String> {
    match source_format {
        "the-wall-dev/2" => {
            // Validate: must have a non-empty templates array.
            let has_templates = payload["templates"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !has_templates {
                return Err(
                    "the-wall-dev/2: payload must contain a non-empty 'templates' array"
                        .to_string(),
                );
            }
            Ok(Converted {
                document: payload.clone(),
                warnings: vec![],
            })
        }

        "the-wall-dev/1" => {
            let doc = wall_dev::v1_to_v2(payload, author_id, created_at)?;
            Ok(Converted {
                document: doc,
                warnings: vec!["converted from the-wall-dev/1 to the-wall-dev/2".into()],
            })
        }

        "charity" => {
            let (doc, charity_warnings) =
                charity::charity_to_v2(payload, author_id, created_at)?;
            let mut warnings = vec!["converted from Charity to the-wall-dev/2".into()];
            warnings.extend(charity_warnings);
            Ok(Converted {
                document: doc,
                warnings,
            })
        }

        other => Err(format!("to_v2: unknown source format '{other}'")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn author() -> Uuid {
        Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap()
    }

    fn ts() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 6, 1, 12, 0, 0).unwrap()
    }

    // Minimal valid v2 document for passthrough tests.
    fn v2_doc() -> Value {
        json!({
            "format": "the-wall-dev/2",
            "createdAt": "2024-06-01T12:00:00+00:00",
            "editedAt": "2024-06-01T12:00:00+00:00",
            "author": { "id": "33333333-3333-3333-3333-333333333333" },
            "templates": [{
                "name": "t",
                "imageSources": ["data:image/png;base64,abc"],
                "x": 0,
                "y": 0,
                "scale": 1.0,
                "width": 10,
                "height": 10
            }]
        })
    }

    #[test]
    fn dispatch_v2_passthrough() {
        let doc = v2_doc();
        let result = to_v2("the-wall-dev/2", &doc, author(), ts()).unwrap();
        assert_eq!(result.document["format"], "the-wall-dev/2");
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn dispatch_v2_empty_templates_returns_err() {
        let mut doc = v2_doc();
        doc["templates"] = json!([]);
        assert!(to_v2("the-wall-dev/2", &doc, author(), ts()).is_err());
    }

    #[test]
    fn dispatch_v2_missing_templates_returns_err() {
        let doc = json!({ "format": "the-wall-dev/2" });
        assert!(to_v2("the-wall-dev/2", &doc, author(), ts()).is_err());
    }

    #[test]
    fn dispatch_v1_converts_and_warns() {
        let v1 = json!({
            "format": "the-wall-dev/1",
            "version": "5.0.0",
            "exported_at": "2024-06-01T12:00:00Z",
            "template": {
                "name": "t",
                "image_data_url": "data:image/png;base64,abc",
                "x": 0,
                "y": 0,
                "scale": 1.0,
                "width": 10,
                "height": 10
            }
        });
        let result = to_v2("the-wall-dev/1", &v1, author(), ts()).unwrap();
        assert_eq!(result.document["format"], "the-wall-dev/2");
        assert!(result.warnings.iter().any(|w| w.contains("the-wall-dev/1")));
    }

    #[test]
    fn dispatch_charity_converts_and_warns() {
        let cfg = json!({
            "templates": [{
                "name": "layer",
                "sources": ["https://example.com/img.png"],
                "x": 0,
                "y": 0
            }]
        });
        let result = to_v2("charity", &cfg, author(), ts()).unwrap();
        assert_eq!(result.document["format"], "the-wall-dev/2");
        assert!(result.warnings.iter().any(|w| w.contains("Charity")));
    }

    #[test]
    fn dispatch_unknown_format_returns_err() {
        let doc = json!({});
        assert!(to_v2("unknown-format", &doc, author(), ts()).is_err());
    }
}
