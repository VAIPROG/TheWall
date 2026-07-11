//! GET  /api/v3/clans/{id}/settings  — read clan settings
//! PATCH /api/v3/clans/{id}/settings — update clan settings (lock-aware)
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{
        ClanChatPermissions, ClanModerationPreferences, ClanSettingsUpdate, ClanSettingsView,
        ClanV3,
    },
    routes::v3::utils::permissions::{effective_clan_role, global_role_of},
};

use super::load_clan;

// ---------------------------------------------------------------------------
// Helper: assemble ClanSettingsView from a raw ClanV3 row
// ---------------------------------------------------------------------------

pub(crate) fn read_settings(clan: &ClanV3) -> ClanSettingsView {
    let s = &clan.settings;

    let template_scope_default = s
        .get("templateScopeDefault")
        .and_then(|v| v.as_str())
        .unwrap_or("clan")
        .to_string();

    let moderation_preferences: ClanModerationPreferences = s
        .get("moderationPreferences")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let chat_permissions: ClanChatPermissions = s
        .get("chatPermissions")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    ClanSettingsView {
        join_policy: clan.join_policy.clone(),
        template_scope_default,
        moderation_preferences,
        chat_permissions,
        discoverable: clan.discoverable,
        default_member_role: "member".to_string(),
        member_cap: clan.max_members.unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/settings
// ---------------------------------------------------------------------------

pub async fn get_settings(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<ClanSettingsView>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Must be an active member OR a global moderator+.
    let is_active_member: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM clan_memberships WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
    )
    .bind(auth.user_id)
    .bind(clan_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let is_owner = clan.owner_id == Some(auth.user_id);

    if !is_owner && is_active_member.is_none() {
        // Check global moderator fallback.
        let global = global_role_of(&state.pool, auth.user_id)
            .await
            .or_500()?;
        if !global.is_moderator() {
            return Err((StatusCode::FORBIDDEN, "must be a clan member to view settings".to_string()));
        }
    }

    Ok(Json(read_settings(&clan)))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/clans/{id}/settings
// ---------------------------------------------------------------------------

pub async fn update_settings(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanSettingsUpdate>,
) -> Result<Json<ClanSettingsView>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Must be a clan admin or higher (effective role).
    let effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?;

    if !effective.map(|r| r.is_admin()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan admin required".to_string()));
    }

    // ── lock-aware: discoverable ──────────────────────────────────────────────
    if body.discoverable.is_some() {
        let locked_fields: Vec<String> = clan
            .moderation
            .get("lockedFields")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        if locked_fields.contains(&"discoverable".to_string()) {
            let caller_global = global_role_of(&state.pool, auth.user_id)
                .await
                .or_500()?;
            if !caller_global.is_moderator() {
                return Err((
                    StatusCode::from_u16(423).unwrap(),
                    "field 'discoverable' is locked by global moderation".to_string(),
                ));
            }
        }
    }

    // ── validate enums when provided ─────────────────────────────────────────
    if let Some(ref jp) = body.join_policy {
        if !["open", "invite_only", "approval_required"].contains(&jp.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "join_policy must be open|invite_only|approval_required".to_string(),
            ));
        }
    }
    if let Some(ref tsd) = body.template_scope_default {
        if !["public", "clan", "private"].contains(&tsd.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "template_scope_default must be public|clan|private".to_string(),
            ));
        }
    }
    if let Some(ref dmr) = body.default_member_role {
        if dmr != "member" {
            return Err((
                StatusCode::BAD_REQUEST,
                "default_member_role must be 'member'".to_string(),
            ));
        }
    }
    if let Some(ref cp) = body.chat_permissions {
        if !["everyone", "members", "moderators"].contains(&cp.who_can_post.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "chat_permissions.who_can_post must be everyone|members|moderators".to_string(),
            ));
        }
        if !["owner", "admins", "moderators", "members"].contains(&cp.who_can_invite.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "chat_permissions.who_can_invite must be owner|admins|moderators|members"
                    .to_string(),
            ));
        }
        if !["everyone", "members", "moderators"].contains(&cp.who_can_post_templates.as_str()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "chat_permissions.who_can_post_templates must be everyone|members|moderators"
                    .to_string(),
            ));
        }
        if cp.slowmode_seconds < 0 {
            return Err((StatusCode::BAD_REQUEST, "slowmode_seconds must be >= 0".to_string()));
        }
    }
    if let Some(cap) = body.member_cap {
        if cap < 0 {
            return Err((StatusCode::BAD_REQUEST, "member_cap must be >= 0".to_string()));
        }
    }

    // ── persist column changes ────────────────────────────────────────────────
    // Build a partial settings JSON patch from the provided sub-keys.
    let mut settings_patch = serde_json::Map::new();
    if let Some(ref tsd) = body.template_scope_default {
        settings_patch.insert(
            "templateScopeDefault".to_string(),
            serde_json::Value::String(tsd.clone()),
        );
    }
    if let Some(ref mp) = body.moderation_preferences {
        settings_patch.insert(
            "moderationPreferences".to_string(),
            serde_json::to_value(mp).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(ref cp) = body.chat_permissions {
        settings_patch.insert(
            "chatPermissions".to_string(),
            serde_json::to_value(cp).unwrap_or(serde_json::Value::Null),
        );
    }

    // Determine column values.
    let new_join_policy = body.join_policy.as_deref().unwrap_or(&clan.join_policy).to_string();
    let new_discoverable = body.discoverable.unwrap_or(clan.discoverable);
    // member_cap: 0 → NULL (no cap), positive → Some(cap).
    let new_max_members: Option<i32> = match body.member_cap {
        Some(0) => None,
        Some(cap) => Some(cap),
        None => clan.max_members,
    };

    if settings_patch.is_empty() {
        // No jsonb change — only column updates.
        sqlx::query(
            "UPDATE clans SET join_policy = $1, discoverable = $2, max_members = $3, updated_at = NOW() WHERE id = $4",
        )
        .bind(&new_join_policy)
        .bind(new_discoverable)
        .bind(new_max_members)
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    } else {
        let patch_value = serde_json::Value::Object(settings_patch);
        sqlx::query(
            r#"UPDATE clans
               SET join_policy  = $1,
                   discoverable = $2,
                   max_members  = $3,
                   settings     = settings || $4::jsonb,
                   updated_at   = NOW()
             WHERE id = $5"#,
        )
        .bind(&new_join_policy)
        .bind(new_discoverable)
        .bind(new_max_members)
        .bind(patch_value)
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    }

    // ── reload + return ───────────────────────────────────────────────────────
    let updated = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "clan vanished after update".to_string()))?;

    Ok(Json(read_settings(&updated)))
}
