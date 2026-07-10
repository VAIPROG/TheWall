use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use std::sync::OnceLock;
use std::time::SystemTime;

use crate::AppState;

#[derive(Debug, Serialize)]
pub struct OwnerInfo {
    pub name: String,
    pub contact: String,
    pub link: Option<String>,
}

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
    pub owner: OwnerInfo,
    pub maintenance: bool,
    pub maintenance_reason: Option<String>,
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

    let extension_version: String = state
        .config
        .extension_version
        .clone()
        .unwrap_or_else(|| "6.0.0".into());

    let rt = state.config.runtime.read().await;
    let maintenance = rt.maintenance_mode;
    let maintenance_reason = rt.maintenance_reason.clone();
    drop(rt);

    Json(Meta {
        version: VERSION,
        extension_version,
        api_versions: vec!["v1", "v2", "v3"],
        // Baked into the binary at `cargo build` time by build.rs.
        built_at: option_env!("BUILD_TIMESTAMP").map(String::from),
        // The boot moment IS the deploy moment for a freshly restarted
        // service — no env var to remember to bump, no stale value.
        deployed_at: Some(started_iso.clone()),
        started_at: started_iso,
        uptime_secs: uptime,
        owner: OwnerInfo {
            name: state.config.owner.name.clone(),
            contact: state.config.owner.contact.clone(),
            link: state.config.owner.link.clone(),
        },
        maintenance,
        maintenance_reason,
    })
}

#[derive(Debug, Serialize)]
pub struct HealthStatus {
    pub status: &'static str,
    pub version: &'static str,
    pub database: &'static str,
}

pub async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();

    let rt = state.config.runtime.read().await;
    let maintenance = rt.maintenance_mode;
    drop(rt);

    let (status, database) = if db_ok && !maintenance {
        ("healthy", "connected")
    } else {
        ("maintenance", if db_ok { "connected" } else { "disconnected" })
    };

    let code = if status == "healthy" {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (code, Json(HealthStatus {
        status,
        version: VERSION,
        database,
    }))
}
