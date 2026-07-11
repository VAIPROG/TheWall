use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use crate::http_error::ResultExt;
use serde::Deserialize;

use crate::{AppState, auth::AuthUser};

#[derive(Debug, Deserialize)]
pub struct DeleteAccountRequest {
    pub reason: Option<String>,
    pub confirm: bool,
}

// POST /api/me/delete — request account deletion (executes immediately for MVP)
pub async fn delete_account(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DeleteAccountRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !body.confirm {
        return Err((StatusCode::BAD_REQUEST, "confirm flag required".to_string()));
    }
    let mut tx = state
        .pool
        .begin()
        .await
        .or_500()?;
    sqlx::query("INSERT INTO account_deletions (id, user_id, reason, requested_at, executed_at) VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())")
        .bind(auth.user_id).bind(&body.reason).execute(&mut *tx).await
        .or_500()?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM notifications WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM clan_messages WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM direct_messages WHERE from_user_id = $1 OR to_user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM templates WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM moderation_applications WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .ok();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await
        .or_500()?;
    tx.commit()
        .await
        .or_500()?;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({"ok": true, "deleted": true})),
    ))
}

#[derive(Debug, Deserialize)]
pub struct UpdateLangRequest {
    pub lang: String,
}

// PUT /api/me/lang
pub async fn update_lang(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UpdateLangRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let lang = body.lang.to_lowercase();
    if !matches!(lang.as_str(), "en" | "ru" | "de" | "fr") {
        return Err((StatusCode::BAD_REQUEST, "unsupported lang".to_string()));
    }
    sqlx::query("UPDATE users SET preferred_lang = $1, updated_at = NOW() WHERE id = $2")
        .bind(&lang)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({"ok": true, "lang": lang})),
    ))
}
