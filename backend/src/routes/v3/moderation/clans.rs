//! Clan-level global-moderation actions — takedown + unlock.
//!
//! Authorization: global moderator+ only.
//!
//!   POST /api/v3/moderation/clans/{clanId}/takedown
//!   POST /api/v3/moderation/clans/{clanId}/unlock

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanTakedownRequest, ClanUnlockRequest, ClanView},
    routes::v3::{
        clans::{build_clan_view, load_clan},
        utils::{audit, permissions},
    },
};

/// Valid presentation fields that can be globally locked or stripped.
const LOCKABLE_FIELDS: &[&str] = &["avatar", "banner", "description", "tag", "discoverable"];

/// Maps a lockable field name to its backing column and the stripped value.
fn field_sql_update(field: &str) -> Option<(&'static str, &'static str)> {
    match field {
        "avatar" => Some(("avatar_url", "NULL")),
        "banner" => Some(("banner_url", "NULL")),
        "description" => Some(("description", "NULL")),
        "tag" => Some(("tag", "NULL")),
        "discoverable" => Some(("discoverable", "FALSE")),
        _ => None,
    }
}

/// Moderator+ gate.
// ---------------------------------------------------------------------------
// POST /api/v3/moderation/clans/{clanId}/takedown
// ---------------------------------------------------------------------------

pub async fn takedown_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanTakedownRequest>,
) -> Result<Json<ClanView>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;

    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    if body.fields.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one field is required".to_string()));
    }
    if body.reason.is_empty() || body.reason.len() > 1000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "reason must be 1–1000 characters".to_string(),
        ));
    }
    if !matches!(body.action.as_str(), "strip" | "strip_and_lock") {
        return Err((StatusCode::BAD_REQUEST, "action must be 'strip' or 'strip_and_lock'".to_string()));
    }

    // Validate and collect column assignments.
    let mut assigns = Vec::new();
    for f in &body.fields {
        if !LOCKABLE_FIELDS.contains(&f.as_str()) {
            return Err((StatusCode::BAD_REQUEST, format!("invalid field: {f}")));
        }
        if let Some((col, val)) = field_sql_update(f) {
            assigns.push(format!("{col} = {val}"));
        }
    }

    let lock = body.action == "strip_and_lock";

    // Build the new moderation jsonb.
    let new_moderation = if lock {
        let current = &clan.moderation;
        let mut locked_fields: Vec<String> = current
            .get("lockedFields")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        for f in &body.fields {
            if !locked_fields.contains(f) {
                locked_fields.push(f.clone());
            }
        }
        Some(json!({
            "lockedFields": locked_fields,
            "lockedBy": auth.user_id.to_string(),
            "lockedAt": chrono::Utc::now().to_rfc3339(),
            "reason": body.reason,
        }))
    } else {
        // strip only: keep the existing moderation lock state (if any).
        None
    };

    // Execute the takedown.
    let mut sql = format!("UPDATE clans SET updated_at = NOW(), moderation = $1");
    for a in &assigns {
        sql.push_str(", ");
        sql.push_str(a);
    }
    sql.push_str(" WHERE id = $2");

    sqlx::query(&sql)
        .bind(new_moderation.clone())
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "clan_takedown",
        "clan",
        &clan_id.to_string(),
        json!({
            "fields": body.fields,
            "action": body.action,
            "reason": body.reason,
        }),
    )
    .await;

    let updated = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;
    Ok(Json(build_clan_view(&state.pool, Some(auth.user_id), updated).await?))
}

// ---------------------------------------------------------------------------
// POST /api/v3/moderation/clans/{clanId}/unlock
// ---------------------------------------------------------------------------

pub async fn unlock_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanUnlockRequest>,
) -> Result<Json<ClanView>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;

    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    if body.fields.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "at least one field is required".to_string()));
    }
    for f in &body.fields {
        if !LOCKABLE_FIELDS.contains(&f.as_str()) {
            return Err((StatusCode::BAD_REQUEST, format!("invalid field: {f}")));
        }
    }

    let current = &clan.moderation;
    let mut locked_fields: Vec<String> = current
        .get("lockedFields")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let before_len = locked_fields.len();
    locked_fields.retain(|f| !body.fields.contains(f));

    let new_moderation = if locked_fields.is_empty() {
        None
    } else {
        Some(json!({
            "lockedFields": locked_fields,
            "lockedBy": current.get("lockedBy").cloned(),
            "lockedAt": current.get("lockedAt").cloned(),
            "reason": current.get("reason").cloned(),
        }))
    };

    sqlx::query("UPDATE clans SET updated_at = NOW(), moderation = $1 WHERE id = $2")
        .bind(new_moderation)
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "clan_unlock",
        "clan",
        &clan_id.to_string(),
        json!({
            "requestedFields": body.fields,
            "removedFields": before_len - locked_fields.len(),
            "reason": body.reason,
        }),
    )
    .await;

    let updated = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;
    Ok(Json(build_clan_view(&state.pool, Some(auth.user_id), updated).await?))
}
// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{field_sql_update, LOCKABLE_FIELDS};

    #[test]
    fn lockable_fields_cover_presentation_columns() {
        for field in LOCKABLE_FIELDS {
            assert!(
                field_sql_update(field).is_some(),
                "{field} must map to a SQL update"
            );
        }
    }

    #[test]
    fn field_sql_update_mappings() {
        assert_eq!(field_sql_update("avatar"), Some(("avatar_url", "NULL")));
        assert_eq!(field_sql_update("banner"), Some(("banner_url", "NULL")));
        assert_eq!(field_sql_update("description"), Some(("description", "NULL")));
        assert_eq!(field_sql_update("tag"), Some(("tag", "NULL")));
        assert_eq!(field_sql_update("discoverable"), Some(("discoverable", "FALSE")));
    }

    #[test]
    fn unknown_field_not_lockable() {
        assert_eq!(field_sql_update("name"), None);
        assert_eq!(field_sql_update("owner_id"), None);
        assert_eq!(field_sql_update(""), None);
    }

    #[test]
    fn lockable_fields_are_stable() {
        let mut fields: Vec<_> = LOCKABLE_FIELDS.iter().copied().collect();
        fields.sort();
        assert_eq!(fields, vec!["avatar", "banner", "description", "discoverable", "tag"]);
    }
}
