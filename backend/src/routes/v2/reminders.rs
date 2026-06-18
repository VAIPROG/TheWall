//! Paint refill reminders (/api/v2/me/paint-reminder).
//!
//! The extension knows exactly when the user's paint refills (it watches the
//! site's paint bar); when the can runs dry it files a reminder here and the
//! reminder worker (crate::reminder_worker) delivers a DM at the due moment
//! via whichever channel the user linked. One pending reminder per user —
//! filing a new one replaces the old (refill estimates move when the user
//! spends paint again).

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use crate::{AppState, auth::AuthUser};

const MAX_DUE_SECS: i64 = 7 * 24 * 3600;

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    /// Seconds from now until the reminder fires.
    pub due_in_secs: i64,
    /// Optional note echoed back in the DM.
    pub note: Option<String>,
    /// 'auto' (default) | 'telegram' | 'discord'
    pub channel: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub id: uuid::Uuid,
    pub due_at: chrono::DateTime<chrono::Utc>,
    pub channel: String,
}

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<CreateBody>,
) -> Result<Json<CreateResponse>, (StatusCode, String)> {
    if b.due_in_secs < 5 || b.due_in_secs > MAX_DUE_SECS {
        return Err((StatusCode::BAD_REQUEST, "due_in_secs out of range".into()));
    }
    let channel = match b.channel.as_deref() {
        None | Some("auto") => "auto",
        Some("telegram") => "telegram",
        Some("discord") => "discord",
        _ => return Err((StatusCode::BAD_REQUEST, "bad channel".into())),
    };
    // The reminder is useless without a deliverable destination — fail loudly
    // now instead of silently never DM-ing.
    let (has_tg, has_dc): (bool, bool) = sqlx::query_as(
        "SELECT telegram_user_id IS NOT NULL, discord_id IS NOT NULL FROM users WHERE id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let deliverable = match channel {
        "telegram" => has_tg,
        "discord" => has_dc,
        _ => has_tg || has_dc,
    };
    if !deliverable {
        return Err((
            StatusCode::CONFLICT,
            "no linked account can receive this reminder — link Telegram or Discord first".into(),
        ));
    }

    let note = b.note.unwrap_or_default();
    let note = note.get(..200).unwrap_or(&note).to_string();
    // Replace any pending reminder: the newest estimate wins.
    sqlx::query("DELETE FROM paint_reminders WHERE user_id = $1 AND NOT sent")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let row: (uuid::Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        r#"INSERT INTO paint_reminders (user_id, due_at, note, channel)
           VALUES ($1, NOW() + ($2 || ' seconds')::interval, $3, $4)
           RETURNING id, due_at"#,
    )
    .bind(auth.user_id)
    .bind(b.due_in_secs.to_string())
    .bind(&note)
    .bind(channel)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(CreateResponse {
        id: row.0,
        due_at: row.1,
        channel: channel.into(),
    }))
}

/// Cancel the pending reminder (e.g. the user toggled the setting off).
pub async fn cancel(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("DELETE FROM paint_reminders WHERE user_id = $1 AND NOT sent")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
