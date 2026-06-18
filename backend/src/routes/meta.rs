use axum::{Json, extract::State, response::IntoResponse};
use serde::Serialize;
use std::sync::OnceLock;
use std::time::SystemTime;

use crate::AppState;

#[derive(Debug, Serialize)]
pub struct Meta {
    /// Backend Cargo version. Bumped on every release.
    pub version: &'static str,
    /// Latest extension version we know about. Falls back to the env hint
    /// `EXTENSION_VERSION` and finally to a baked-in default — the landing
    /// JS uses it to render "Extension vX · Backend vY" in the footer.
    pub extension_version: String,
    pub api_versions: Vec<&'static str>,
    pub built_at: Option<String>,
    pub deployed_at: Option<String>,
    pub started_at: String,
    pub uptime_secs: u64,
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

static STARTED_AT: OnceLock<SystemTime> = OnceLock::new();

pub fn boot() {
    let _ = STARTED_AT.set(SystemTime::now());
}

fn iso(t: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339()
}

pub async fn get_meta(State(state): State<AppState>) -> impl IntoResponse {
    let start = STARTED_AT.get().copied().unwrap_or_else(SystemTime::now);
    let uptime = start.elapsed().map(|d| d.as_secs()).unwrap_or(0);
    let started_iso = iso(start);

    let extension_version: String = sqlx::query_scalar(
        "SELECT value FROM server_config WHERE key = 'extension_version'",
    )
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "4.0.0".into());

    Json(Meta {
        version: VERSION,
        extension_version,
        api_versions: vec!["v1", "v2"],
        // Baked into the binary at `cargo build` time by build.rs.
        built_at: option_env!("BUILD_TIMESTAMP").map(String::from),
        // The boot moment IS the deploy moment for a freshly restarted
        // service — no env var to remember to bump, no stale value.
        deployed_at: Some(started_iso.clone()),
        started_at: started_iso,
        uptime_secs: uptime,
    })
}
