//! Avatar endpoints:
//!   POST   /api/v3/users/me/avatar
//!   DELETE /api/v3/users/me/avatar
//!
//! Reuses the existing `avatars` table. The stored `image` field holds a URL
//! or base64 data URI that the frontend renders.

use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};
use serde_json::json;

use crate::{AppState, auth::AuthUser, routes::v3::utils::audit};

/// Max uploaded avatar size (2 MiB).
const AVATAR_MAX_BYTES: usize = 2 * 1024 * 1024;

pub async fn upload_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut image_data: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            if data.len() > AVATAR_MAX_BYTES {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "avatar too large".to_string()));
            }
            image_data = Some(data.to_vec());
            break;
        }
    }

    let image_data = image_data.ok_or_else(|| (StatusCode::BAD_REQUEST, "missing file".to_string()))?;

    // Validate image format using the image crate.
    let format = image::guess_format(&image_data)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid image: {e}")))?;
    if !matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP | image::ImageFormat::Gif) {
        return Err((StatusCode::BAD_REQUEST, "unsupported format".to_string()));
    }

    // Store as base64 data URI so it is self-contained.
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image_data);
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Gif => "image/gif",
        _ => unreachable!(),
    };
    let image_url = format!("data:{mime};base64,{encoded}");

    sqlx::query(
        r#"INSERT INTO avatars (user_id, image, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET image = EXCLUDED.image, updated_at = NOW()"#,
    )
    .bind(auth.user_id)
    .bind(&image_url)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "avatar_uploaded",
        "user",
        &auth.user_id.to_string(),
        json!({ "mime": mime }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "avatar uploaded", "avatarUrl": image_url})))
}

pub async fn delete_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "avatar_removed",
        "user",
        &auth.user_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "avatar removed"})))
}
