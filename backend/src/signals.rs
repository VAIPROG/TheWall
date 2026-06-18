//! Periodic mirror of filianislost.com's `signal.filianislost.com/fetch`
//! endpoint.
//!
//! Pagination: we walk pages via `after=<offset>` until we either get an
//! empty page or a page where every row already exists in our cache (i.e.
//! we've caught up to the tail). A safety cap of `MAX_PAGES` prevents the
//! loop from running away if upstream ignores `after`.
//!
//! Dedup story (post-migration 010): every row carries a non-null
//! `external_id` so `ON CONFLICT (source, external_id) DO NOTHING` actually
//! fires. We prefer the upstream's `num_id`/`id`; fall back to a SHA256 of a
//! narrow content slice.

use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::time::Duration;

const SIGNALS_URL: &str = "https://signal.filianislost.com/fetch";
const PAGE_SIZE: i64 = 64;
const MAX_PAGES: usize = 32;

pub async fn poll_once(pool: &PgPool) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut after: i64 = 0;
    let mut total_seen = 0usize;
    let mut total_new = 0usize;

    for page in 0..MAX_PAGES {
        let at = chrono::Utc::now().timestamp_millis();
        let url = format!("{SIGNALS_URL}?tag=&after={after}&limit={PAGE_SIZE}&at={at}");
        let r = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("upstream status {}", r.status()));
        }
        let body: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
        let items = extract_items(&body);
        if items.is_empty() {
            tracing::debug!("signals: empty page {page} at after={after}, stopping");
            break;
        }

        let mut page_new = 0usize;
        for item in &items {
            let ext_id = dedup_key(item);
            let tag = item
                .get("tag")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let res = sqlx::query(
                r#"INSERT INTO signals_cache (source, external_id, tag, payload)
                   VALUES ('filianislost', $1, $2, $3)
                   ON CONFLICT (source, external_id) DO NOTHING"#,
            )
            .bind(ext_id)
            .bind(tag)
            .bind(item)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
            if res.rows_affected() > 0 {
                page_new += 1;
            }
        }
        total_seen += items.len();
        total_new += page_new;

        // Caught up: every row on this page was already in our cache.
        if page_new == 0 {
            tracing::debug!("signals: page {page} fully dedupes (after={after}), stopping");
            break;
        }
        after += items.len() as i64;
    }
    tracing::info!("signals poll: seen={total_seen} new={total_new}");
    Ok(())
}

fn extract_items(body: &serde_json::Value) -> Vec<serde_json::Value> {
    match body {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(map) => map
            .get("signals")
            .or_else(|| map.get("items"))
            .or_else(|| map.get("data"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Compute a stable dedup key. Prefer upstream stable ids; otherwise hash a
/// narrow subset of fields so the same logical signal collapses anyway.
fn dedup_key(p: &serde_json::Value) -> String {
    for (prefix, key) in [("n", "num_id"), ("i", "id")] {
        match p.get(key) {
            Some(serde_json::Value::Number(n)) => return format!("{prefix}:{n}"),
            Some(serde_json::Value::String(s)) if !s.is_empty() => {
                return format!("{prefix}:{s}");
            }
            _ => {}
        }
    }
    let mut h = Sha256::new();
    for k in ["name", "location", "image_file", "submitted_at"] {
        h.update(k.as_bytes());
        h.update(b":");
        if let Some(v) = p.get(k) {
            h.update(v.to_string().as_bytes());
        }
        h.update(b";");
    }
    let bytes = h.finalize();
    let mut s = String::from("h:");
    for b in &bytes[..12] {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
