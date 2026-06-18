//! Notification preferences: per-mailbox-kind, per-channel routing.
//!
//! Channels we currently know about (storage only — actual fan-out lives in
//! mailbox creation helpers):
//!   - in_app   (always shows in /mailbox)
//!   - os_push  (browser Notification API; extension already handles this)
//!   - email    (server SMTP — not wired up yet)
//!   - discord  (bot message — wired up later when we register one)
//!   - telegram (bot message — wired up later)
//!
//! Defaults for kinds that don't have an explicit row: in_app + os_push only.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use crate::{AppState, auth::AuthUser};

pub const ALL_KINDS: &[&str] = &[
    "announcement",
    "clan_alert",
    "clan_announcement",
    "mod_alert",
    "modmail",
    "dm",
    "template_event",
];

pub const ALL_CHANNELS: &[&str] = &["in_app", "os_push", "email", "discord", "telegram"];

fn default_channels(kind: &str) -> Vec<String> {
    match kind {
        // Important — should hit OS push by default.
        "announcement" | "clan_alert" | "mod_alert" | "dm" => {
            vec!["in_app".into(), "os_push".into()]
        }
        // Quieter — in-app only.
        _ => vec!["in_app".into()],
    }
}

#[derive(Debug, Serialize)]
pub struct PrefRow {
    pub kind: String,
    pub channels: Vec<String>,
    pub is_default: bool,
}

pub async fn get_me(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<PrefRow>>, (StatusCode, String)> {
    let rows: Vec<(String, Vec<String>)> =
        sqlx::query_as("SELECT kind, channels FROM notification_prefs WHERE user_id = $1")
            .bind(auth.user_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let stored: HashMap<String, Vec<String>> = rows.into_iter().collect();
    let mut out = Vec::with_capacity(ALL_KINDS.len());
    for &k in ALL_KINDS {
        if let Some(chans) = stored.get(k) {
            out.push(PrefRow {
                kind: k.into(),
                channels: chans.clone(),
                is_default: false,
            });
        } else {
            out.push(PrefRow {
                kind: k.into(),
                channels: default_channels(k),
                is_default: true,
            });
        }
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
pub struct UpdateRequest {
    pub kind: String,
    pub channels: Vec<String>,
}

pub async fn update_me(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UpdateRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !ALL_KINDS.contains(&body.kind.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("unknown kind: {}", body.kind),
        ));
    }
    for c in &body.channels {
        if !ALL_CHANNELS.contains(&c.as_str()) {
            return Err((StatusCode::BAD_REQUEST, format!("unknown channel: {c}")));
        }
    }
    sqlx::query(
        r#"INSERT INTO notification_prefs (user_id, kind, channels)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, kind) DO UPDATE
             SET channels = EXCLUDED.channels, updated_at = NOW()"#,
    )
    .bind(auth.user_id)
    .bind(&body.kind)
    .bind(&body.channels)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}
