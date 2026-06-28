//! Pure document-mutation function for the V3 template PATCH endpoint.
//!
//! `apply_patch` is deliberately free of async, I/O, and Axum types so it can
//! be unit-tested in isolation without a database or runtime.

use crate::models::{DocPatch, LayerOp};

/// Apply a `TemplatePatchV3` payload to a mutable the-wall-dev/2 document.
///
/// # Arguments
/// * `document`     – mutable reference to the stored JSONB value.
/// * `doc`          – optional document-level field patch.
/// * `ops`          – optional ordered list of layer operations.
/// * `now_rfc3339`  – RFC 3339 timestamp to stamp into `editedAt`.
///
/// # Errors
/// Returns a human-readable `String` on any structural violation (missing
/// templates array, out-of-range index, remove-last-layer guard).
pub fn apply_patch(
    document: &mut serde_json::Value,
    doc: &Option<DocPatch>,
    ops: &Option<Vec<LayerOp>>,
    now_rfc3339: &str,
) -> Result<(), String> {
    // Ensure document is an object with a templates array.
    let obj = document
        .as_object_mut()
        .ok_or_else(|| "document is not an object".to_string())?;

    if obj.get("templates").and_then(|t| t.as_array()).is_none() {
        return Err("document missing templates".to_string());
    }

    // ── doc-level patches ────────────────────────────────────────────────────
    if let Some(d) = doc {
        if let Some(notes) = &d.notes {
            obj.insert(
                "notes".to_string(),
                serde_json::Value::Array(
                    notes
                        .iter()
                        .map(|s| serde_json::Value::String(s.clone()))
                        .collect(),
                ),
            );
        }

        if let Some(contacts) = &d.contacts {
            obj.insert("contacts".to_string(), contacts.clone());
        }

        // Merge access fields: set only the keys that are present in the patch.
        if let Some(access) = &d.access {
            if let Some(access_obj) = access.as_object() {
                for (k, v) in access_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }

        if let Some(vis) = &d.author_visibility {
            match vis.as_str() {
                "anon" => {
                    obj.insert("author".to_string(), serde_json::Value::String("anon".to_string()));
                }
                "hidden" => {
                    obj.insert("author".to_string(), serde_json::Value::Null);
                }
                "full" => {
                    // no-op: full identity set at create/merge time
                }
                other => {
                    return Err(format!(
                        "authorVisibility must be full|anon|hidden, got '{other}'"
                    ));
                }
            }
        }

        // name → set on primary layer (templates[0].name)
        if let Some(name) = &d.name {
            let templates = obj
                .get_mut("templates")
                .and_then(|t| t.as_array_mut())
                .ok_or_else(|| "document missing templates".to_string())?;
            let layer = templates
                .first_mut()
                .ok_or_else(|| "document.templates is empty".to_string())?;
            if let Some(layer_obj) = layer.as_object_mut() {
                layer_obj.insert("name".to_string(), serde_json::Value::String(name.clone()));
            }
        }
    }

    // ── layer operations ─────────────────────────────────────────────────────
    if let Some(layer_ops) = ops {
        for op in layer_ops {
            let templates = obj
                .get_mut("templates")
                .and_then(|t| t.as_array_mut())
                .ok_or_else(|| "document missing templates".to_string())?;

            match op {
                LayerOp::Add { layer, at_index } => {
                    let idx = at_index.unwrap_or(templates.len());
                    if idx > templates.len() {
                        return Err(format!(
                            "add atIndex {idx} is out of range (len={})",
                            templates.len()
                        ));
                    }
                    templates.insert(idx, layer.clone());
                }
                LayerOp::Remove { index } => {
                    if *index >= templates.len() {
                        return Err(format!(
                            "remove index {index} is out of range (len={})",
                            templates.len()
                        ));
                    }
                    if templates.len() == 1 {
                        return Err(
                            "remove would empty templates — at least one layer required"
                                .to_string(),
                        );
                    }
                    templates.remove(*index);
                }
                LayerOp::Move { from, to } => {
                    let len = templates.len();
                    if *from >= len {
                        return Err(format!(
                            "move from={from} is out of range (len={len})"
                        ));
                    }
                    if *to >= len {
                        return Err(format!(
                            "move to={to} is out of range (len={len})"
                        ));
                    }
                    let item = templates.remove(*from);
                    templates.insert(*to, item);
                }
                LayerOp::Update { index, patch } => {
                    if *index >= templates.len() {
                        return Err(format!(
                            "update index {index} is out of range (len={})",
                            templates.len()
                        ));
                    }
                    let layer = &mut templates[*index];
                    if let (Some(layer_obj), Some(patch_obj)) =
                        (layer.as_object_mut(), patch.as_object())
                    {
                        for (k, v) in patch_obj {
                            if v.is_null() {
                                layer_obj.remove(k);
                            } else {
                                layer_obj.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // Always stamp editedAt.
    obj.insert(
        "editedAt".to_string(),
        serde_json::Value::String(now_rfc3339.to_string()),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_doc() -> serde_json::Value {
        json!({
            "format": "the-wall-dev/2",
            "createdAt": "2024-01-01T00:00:00Z",
            "editedAt": "2024-01-01T00:00:00Z",
            "author": {"id": "00000000-0000-0000-0000-000000000001", "name": "Alice"},
            "notes": [],
            "templates": [
                {
                    "name": "Layer 0",
                    "imageSources": ["data:image/png;base64,abc"],
                    "x": 10, "y": 20, "scale": 1.0,
                    "width": 100, "height": 100
                }
            ]
        })
    }

    fn base_doc_two_layers() -> serde_json::Value {
        json!({
            "format": "the-wall-dev/2",
            "createdAt": "2024-01-01T00:00:00Z",
            "editedAt": "2024-01-01T00:00:00Z",
            "templates": [
                {"name": "Layer 0", "imageSources": ["data:image/png;base64,a"], "x": 0, "y": 0, "scale": 1.0, "width": 10, "height": 10},
                {"name": "Layer 1", "imageSources": ["data:image/png;base64,b"], "x": 5, "y": 5, "scale": 1.0, "width": 10, "height": 10}
            ]
        })
    }

    const NOW: &str = "2025-06-01T12:00:00Z";

    // --- notes / contacts ---------------------------------------------------

    #[test]
    fn test_set_notes() {
        let mut doc = base_doc();
        let patch = DocPatch {
            name: None,
            notes: Some(vec!["note1".to_string(), "note2".to_string()]),
            contacts: None,
            access: None,
            author_visibility: None,
        };
        apply_patch(&mut doc, &Some(patch), &None, NOW).unwrap();
        assert_eq!(doc["notes"], json!(["note1", "note2"]));
        assert_eq!(doc["editedAt"], json!(NOW));
    }

    #[test]
    fn test_set_contacts() {
        let mut doc = base_doc();
        let patch = DocPatch {
            name: None,
            notes: None,
            contacts: Some(json!({"discord": [{"type": "guild", "link": "https://discord.gg/abc"}]})),
            access: None,
            author_visibility: None,
        };
        apply_patch(&mut doc, &Some(patch), &None, NOW).unwrap();
        assert!(doc["contacts"]["discord"].is_array());
    }

    // --- authorVisibility ---------------------------------------------------

    #[test]
    fn test_author_visibility_anon() {
        let mut doc = base_doc();
        let patch = DocPatch {
            name: None,
            notes: None,
            contacts: None,
            access: None,
            author_visibility: Some("anon".to_string()),
        };
        apply_patch(&mut doc, &Some(patch), &None, NOW).unwrap();
        assert_eq!(doc["author"], json!("anon"));
    }

    #[test]
    fn test_author_visibility_hidden() {
        let mut doc = base_doc();
        let patch = DocPatch {
            name: None,
            notes: None,
            contacts: None,
            access: None,
            author_visibility: Some("hidden".to_string()),
        };
        apply_patch(&mut doc, &Some(patch), &None, NOW).unwrap();
        assert!(doc["author"].is_null());
    }

    #[test]
    fn test_author_visibility_full_is_noop() {
        let mut doc = base_doc();
        let original_author = doc["author"].clone();
        let patch = DocPatch {
            name: None,
            notes: None,
            contacts: None,
            access: None,
            author_visibility: Some("full".to_string()),
        };
        apply_patch(&mut doc, &Some(patch), &None, NOW).unwrap();
        assert_eq!(doc["author"], original_author);
    }

    #[test]
    fn test_author_visibility_invalid() {
        let mut doc = base_doc();
        let patch = DocPatch {
            name: None,
            notes: None,
            contacts: None,
            access: None,
            author_visibility: Some("public".to_string()),
        };
        let result = apply_patch(&mut doc, &Some(patch), &None, NOW);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("authorVisibility"));
    }

    // --- layer ops: add -----------------------------------------------------

    #[test]
    fn test_layer_add_push() {
        let mut doc = base_doc();
        let new_layer = json!({"name": "New", "imageSources": ["data:image/png;base64,x"], "x": 0, "y": 0, "scale": 1.0, "width": 5, "height": 5});
        let ops = vec![LayerOp::Add { layer: new_layer.clone(), at_index: None }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        let templates = doc["templates"].as_array().unwrap();
        assert_eq!(templates.len(), 2);
        assert_eq!(templates[1]["name"], json!("New"));
    }

    #[test]
    fn test_layer_add_at_index() {
        let mut doc = base_doc_two_layers();
        let new_layer = json!({"name": "Middle", "imageSources": ["data:image/png;base64,m"], "x": 0, "y": 0, "scale": 1.0, "width": 5, "height": 5});
        let ops = vec![LayerOp::Add { layer: new_layer, at_index: Some(1) }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        let templates = doc["templates"].as_array().unwrap();
        assert_eq!(templates.len(), 3);
        assert_eq!(templates[1]["name"], json!("Middle"));
        assert_eq!(templates[2]["name"], json!("Layer 1"));
    }

    #[test]
    fn test_layer_add_out_of_range() {
        let mut doc = base_doc();
        let new_layer = json!({"name": "X", "imageSources": [], "x": 0, "y": 0, "scale": 1.0, "width": 1, "height": 1});
        let ops = vec![LayerOp::Add { layer: new_layer, at_index: Some(99) }];
        let result = apply_patch(&mut doc, &None, &Some(ops), NOW);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("out of range"));
    }

    // --- layer ops: remove --------------------------------------------------

    #[test]
    fn test_layer_remove() {
        let mut doc = base_doc_two_layers();
        let ops = vec![LayerOp::Remove { index: 0 }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        let templates = doc["templates"].as_array().unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0]["name"], json!("Layer 1"));
    }

    #[test]
    fn test_layer_remove_last_guard() {
        let mut doc = base_doc();
        let ops = vec![LayerOp::Remove { index: 0 }];
        let result = apply_patch(&mut doc, &None, &Some(ops), NOW);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("at least one layer required"));
    }

    #[test]
    fn test_layer_remove_out_of_range() {
        let mut doc = base_doc_two_layers();
        let ops = vec![LayerOp::Remove { index: 5 }];
        let result = apply_patch(&mut doc, &None, &Some(ops), NOW);
        assert!(result.is_err());
    }

    // --- layer ops: move ----------------------------------------------------

    #[test]
    fn test_layer_move() {
        let mut doc = base_doc_two_layers();
        let ops = vec![LayerOp::Move { from: 0, to: 1 }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        let templates = doc["templates"].as_array().unwrap();
        assert_eq!(templates[0]["name"], json!("Layer 1"));
        assert_eq!(templates[1]["name"], json!("Layer 0"));
    }

    #[test]
    fn test_layer_move_from_out_of_range() {
        let mut doc = base_doc();
        let ops = vec![LayerOp::Move { from: 5, to: 0 }];
        let result = apply_patch(&mut doc, &None, &Some(ops), NOW);
        assert!(result.is_err());
    }

    // --- layer ops: update --------------------------------------------------

    #[test]
    fn test_layer_update_merge() {
        let mut doc = base_doc();
        let patch_val = json!({"description": "Cool template", "scale": 2.0});
        let ops = vec![LayerOp::Update { index: 0, patch: patch_val }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        assert_eq!(doc["templates"][0]["description"], json!("Cool template"));
        assert_eq!(doc["templates"][0]["scale"], json!(2.0));
        // Original fields still present
        assert_eq!(doc["templates"][0]["name"], json!("Layer 0"));
    }

    #[test]
    fn test_layer_update_null_removal() {
        let mut doc = base_doc();
        // First add a description field, then remove it with null
        let add_patch = json!({"description": "To be removed"});
        let ops = vec![LayerOp::Update { index: 0, patch: add_patch }];
        apply_patch(&mut doc, &None, &Some(ops), NOW).unwrap();
        assert_eq!(doc["templates"][0]["description"], json!("To be removed"));

        let remove_patch = json!({"description": null});
        let ops2 = vec![LayerOp::Update { index: 0, patch: remove_patch }];
        apply_patch(&mut doc, &None, &Some(ops2), NOW).unwrap();
        assert!(doc["templates"][0].get("description").is_none());
    }

    #[test]
    fn test_layer_update_out_of_range() {
        let mut doc = base_doc();
        let ops = vec![LayerOp::Update { index: 3, patch: json!({"name": "X"}) }];
        let result = apply_patch(&mut doc, &None, &Some(ops), NOW);
        assert!(result.is_err());
    }

    // --- editedAt always stamped -------------------------------------------

    #[test]
    fn test_edited_at_always_stamped() {
        let mut doc = base_doc();
        // No-op patch (both None)
        apply_patch(&mut doc, &None, &None, NOW).unwrap();
        assert_eq!(doc["editedAt"], json!(NOW));
    }

    // --- missing templates array -------------------------------------------

    #[test]
    fn test_missing_templates_err() {
        let mut doc = json!({"format": "the-wall-dev/2", "createdAt": "2024-01-01T00:00:00Z", "editedAt": "2024-01-01T00:00:00Z"});
        let result = apply_patch(&mut doc, &None, &None, NOW);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing templates"));
    }

    #[test]
    fn test_not_object_err() {
        let mut doc = json!([]);
        let result = apply_patch(&mut doc, &None, &None, NOW);
        assert!(result.is_err());
    }
}
