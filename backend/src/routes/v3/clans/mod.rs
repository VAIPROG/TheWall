//! V3 Clan CRUD — list, create, get, update, members, lifecycle.

mod create;
mod detail;
mod lifecycle;
mod list;
mod members;

pub use create::create_clan;
pub use detail::{get_clan, update_clan};
pub use lifecycle::{disband_clan, leave_clan};
pub use list::list_clans;
pub use members::{get_member, kick_member, list_members, update_member_role};

use axum::http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    models::{ClanModerationState, ClanStats, ClanV3, ClanView, ClanViewerContext},
    routes::v3::utils::permissions::{clan_role_of, effective_clan_role},
};

pub(crate) const NATIVE_SOURCE: &str = "the-wall-dev";

/// Load a clan row by id; returns None if the clan doesn't exist.
pub(crate) async fn load_clan(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<ClanV3>, (StatusCode, String)> {
    sqlx::query_as::<_, ClanV3>(
        r#"SELECT id, source, external_id, name, display_name, discord_id, icon,
                  stats, created_at, updated_at,
                  avatar_url, banner_url, description, tag, verified, discoverable,
                  lang, max_members, owner_id, join_policy, settings, moderation
           FROM clans WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Build the full `ClanView` wire shape from a raw `ClanV3` row.
pub(crate) async fn build_clan_view(
    pool: &PgPool,
    viewer_id: Option<Uuid>,
    clan: ClanV3,
) -> Result<ClanView, (StatusCode, String)> {
    // ── member count ──────────────────────────────────────────────────────────
    let member_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM clan_memberships WHERE clan_id = $1 AND active = TRUE",
    )
    .bind(clan.id)
    .fetch_one(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // ── template count ────────────────────────────────────────────────────────
    let template_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM templates WHERE clan_id = $1 AND scope = 'clan'",
    )
    .bind(clan.id)
    .fetch_one(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // ── chat_id (do NOT create; None if absent) ───────────────────────────────
    let chat_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM chats WHERE type = 'clan' AND clan_id = $1",
    )
    .bind(clan.id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // ── moderation (parse jsonb) ──────────────────────────────────────────────
    let moderation: Option<ClanModerationState> = {
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

        if locked_fields.is_empty() {
            None
        } else {
            let locked_by: Option<Uuid> = clan
                .moderation
                .get("lockedBy")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok());
            let locked_at: Option<chrono::DateTime<chrono::Utc>> = clan
                .moderation
                .get("lockedAt")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok());
            let reason: Option<String> = clan
                .moderation
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(ClanModerationState {
                locked_fields,
                locked_by,
                locked_at,
                reason,
            })
        }
    };

    // ── links (from settings.links) ───────────────────────────────────────────
    let links: Vec<serde_json::Value> = clan
        .settings
        .get("links")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // ── viewer context ────────────────────────────────────────────────────────
    let viewer: Option<ClanViewerContext> = if let Some(uid) = viewer_id {
        let actual_role = clan_role_of(pool, uid, clan.id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let effective = effective_clan_role(pool, uid, clan.id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let is_active_member: Option<bool> = sqlx::query_scalar(
            "SELECT TRUE FROM clan_memberships WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
        )
        .bind(uid)
        .bind(clan.id)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let is_owner = clan.owner_id == Some(uid);
        let membership_status = if is_owner || is_active_member.is_some() {
            "member".to_string()
        } else {
            "none".to_string()
        };

        let role_str = actual_role.map(|r| r.as_str().to_string());
        let can_manage_members = effective.map(|r| r.is_admin()).unwrap_or(false);
        let can_manage_settings = effective.map(|r| r.is_admin()).unwrap_or(false);
        let can_moderate_chat = effective.map(|r| r.is_moderator()).unwrap_or(false);
        let can_post_templates = is_owner || is_active_member.is_some();

        Some(ClanViewerContext {
            role: role_str,
            membership_status,
            can_manage_members,
            can_manage_settings,
            can_moderate_chat,
            can_post_templates,
        })
    } else {
        None
    };

    Ok(ClanView {
        id: clan.id,
        name: clan.name,
        description: clan.description.unwrap_or_default(),
        avatar_url: clan.avatar_url,
        owner_id: clan.owner_id,
        member_count,
        chat_id,
        join_policy: clan.join_policy,
        created_at: clan.created_at,
        updated_at: clan.updated_at,
        tag: clan.tag,
        banner_url: clan.banner_url,
        verified: clan.verified,
        discoverable: clan.discoverable,
        lang: clan.lang,
        links,
        max_members: clan.max_members,
        stats: ClanStats {
            member_count,
            template_count,
            online_count: None,
        },
        viewer,
        moderation,
    })
}
