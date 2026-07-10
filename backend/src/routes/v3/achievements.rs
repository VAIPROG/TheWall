//! V3 achievements API.
//!
//! Endpoints:
//!   GET    /api/v3/users/me/achievements          — own catalogue + grants
//!   POST   /api/v3/users/me/achievements/recheck  — re-evaluate condition-based
//!   GET    /api/v3/users/{ref}/achievements       — public unlocked list
//!   POST   /api/v3/users/me/achievements/event    — client-fired event
//!
//! Admin:
//!   GET    /api/v3/admin/achievements/catalog
//!   GET    /api/v3/admin/achievements/grants
//!   POST   /api/v3/admin/achievements/{id}/grant  — grant to user
//!   DELETE /api/v3/admin/achievements/{id}/revoke/{user_id} — revoke from user

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::achievements::{
        AchievementCatalog, AchievementEventRequest, AchievementEventResponse,
        AchievementGrant, AchievementRecheckResponse, GrantSource, Rarity, UnlockCriteria,
    },
    routes::v3::utils::{permissions, users::resolve_user_ref},
};

#[derive(Debug, Deserialize)]
pub struct CatalogQuery {
    pub include_secret: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct GrantsQuery {
    pub user_id: Option<Uuid>,
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AdminGrantBody {
    pub user_id: Uuid,
    pub reason: Option<String>,
    pub metadata: Option<Value>,
}

// Combined row returned by the JOIN of achievements + achievement_grants.
#[derive(Debug, FromRow)]
struct GrantWithCatalogRow {
    // achievement columns
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_url: Option<String>,
    pub category: String,
    pub points: i32,
    pub secret: bool,
    pub rarity: String,
    pub unlock_kind: String,
    pub unlock_config: Option<Value>,
    // grant columns
    pub grant_id: Uuid,
    pub user_id: Uuid,
    pub achievement_id: String,
    pub source: String,
    pub source_id: Option<Uuid>,
    pub reason: Option<String>,
    pub metadata: Option<Value>,
    pub granted_at: DateTime<Utc>,
}

impl GrantWithCatalogRow {
    fn into_grant(self) -> AchievementGrant {
        let catalog = AchievementCatalog {
            id: self.id,
            category: self.category,
            title: self.name,
            description: self.description,
            icon_url: self.icon_url,
            rarity: Rarity::from_str(&self.rarity),
            unlock_criteria: UnlockCriteria::from_db(&self.unlock_kind, self.unlock_config),
            points: self.points as u32,
            secret: self.secret,
        };
        let granted_by = match self.source.as_str() {
            "admin" => GrantSource::Admin {
                by: self.source_id.map(|u| u.to_string()).unwrap_or_default(),
                reason: self.reason.clone(),
            },
            "event" => GrantSource::Event {
                name: self.reason.clone().unwrap_or_else(|| "unknown".to_string()),
            },
            "self" => GrantSource::SelfUnlocked,
            _ => GrantSource::System,
        };
        AchievementGrant {
            achievement: catalog,
            granted_at: self.granted_at,
            granted_by,
            metadata: self.metadata.unwrap_or(json!({})),
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/v3/users/me/achievements
// ---------------------------------------------------------------------------

pub async fn list_my_achievements(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<AchievementGrant>>, (StatusCode, String)> {
    list_user_achievements_inner(&state.pool, auth.user_id, auth.user_id, true)
        .await
        .map(Json)
}

// ---------------------------------------------------------------------------
// GET /api/v3/users/{user_ref}/achievements
// ---------------------------------------------------------------------------

pub async fn list_user_achievements(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<Vec<AchievementGrant>>, (StatusCode, String)> {
    let user_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;
    list_user_achievements_inner(&state.pool, user_id, auth.user_id, false)
        .await
        .map(Json)
}

async fn list_user_achievements_inner(
    pool: &sqlx::PgPool,
    target_id: Uuid,
    viewer_id: Uuid,
    is_self: bool,
) -> Result<Vec<AchievementGrant>, (StatusCode, String)> {
    let rows: Vec<GrantWithCatalogRow> = sqlx::query_as(
        r#"SELECT
             a.id, a.name, a.description, a.icon, a.icon_url, a.category, a.points, a.secret,
             a.rarity, a.unlock_kind, a.unlock_config,
             g.id as grant_id, g.user_id, g.achievement_id, g.source, g.source_id, g.reason, g.metadata, g.granted_at
             FROM achievement_grants g
             JOIN achievements a ON a.id = g.achievement_id
            WHERE g.user_id = $1
         ORDER BY g.granted_at DESC"#,
    )
    .bind(target_id)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut grants = Vec::new();
    for row in rows {
        // Secret achievements are only visible to the owner or to admins/mods.
        if row.secret && !is_self {
            let viewer_global = permissions::global_role_of(pool, viewer_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            if !viewer_global.is_moderator() {
                continue;
            }
        }
        grants.push(row.into_grant());
    }

    Ok(grants)
}

// ---------------------------------------------------------------------------
// POST /api/v3/users/me/achievements/recheck
// ---------------------------------------------------------------------------

pub async fn recheck_my_achievements(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<AchievementRecheckResponse>, (StatusCode, String)> {
    let newly = evaluate_and_grant(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(AchievementRecheckResponse { newly_unlocked: newly }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/users/me/achievements/event
// ---------------------------------------------------------------------------

pub async fn record_event(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<AchievementEventRequest>,
) -> Result<Json<AchievementEventResponse>, (StatusCode, String)> {
    const ALLOWED: &[&str] = &[
        "emote_explorer",
        "snapshot_viewer",
        "compact_mode_enabled",
        "precise_place",
        "first_pinned",
        "extension_installed",
        "profile_complete",
        "vai_pinged",
        "found_the_dev",
        "night_owl",
    ];

    if !ALLOWED.contains(&body.event.as_str()) {
        return Ok(Json(AchievementEventResponse {
            new: false,
            achievement: None,
        }));
    }

    // Log the event for audit + recheck support.
    sqlx::query(
        "INSERT INTO achievement_event_log (user_id, event, metadata) VALUES ($1, $2, $3)",
    )
    .bind(auth.user_id)
    .bind(&body.event)
    .bind(body.metadata.clone())
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let catalog = grant_by_event(&state.pool, auth.user_id, &body.event)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(AchievementEventResponse {
        new: catalog.is_some(),
        achievement: catalog,
    }))
}

// ---------------------------------------------------------------------------
// Admin: GET /api/v3/admin/achievements/catalog
// ---------------------------------------------------------------------------

pub async fn admin_catalog(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(_q): Query<CatalogQuery>,
) -> Result<Json<Vec<AchievementCatalog>>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let rows: Vec<CatalogRow> = sqlx::query_as(
        "SELECT id, name, description, icon, icon_url, category, points, secret, rarity, unlock_kind, unlock_config \
         FROM achievements ORDER BY category, points DESC, id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows.into_iter().map(|r| r.into_catalog()).collect()))
}

// ---------------------------------------------------------------------------
// Admin: GET /api/v3/admin/achievements/grants
// ---------------------------------------------------------------------------

pub async fn admin_grants(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<GrantsQuery>,
) -> Result<Json<Vec<AchievementGrant>>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let rows: Vec<GrantWithCatalogRow> = if let Some(uid) = q.user_id {
        sqlx::query_as(
            r#"SELECT
                 a.id, a.name, a.description, a.icon, a.icon_url, a.category, a.points, a.secret,
                 a.rarity, a.unlock_kind, a.unlock_config,
                 g.id as grant_id, g.user_id, g.achievement_id, g.source, g.source_id, g.reason, g.metadata, g.granted_at
                 FROM achievement_grants g
                 JOIN achievements a ON a.id = g.achievement_id
                WHERE g.user_id = $1
             ORDER BY g.granted_at DESC
             LIMIT $2 OFFSET $3"#,
        )
        .bind(uid)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
    } else {
        sqlx::query_as(
            r#"SELECT
                 a.id, a.name, a.description, a.icon, a.icon_url, a.category, a.points, a.secret,
                 a.rarity, a.unlock_kind, a.unlock_config,
                 g.id as grant_id, g.user_id, g.achievement_id, g.source, g.source_id, g.reason, g.metadata, g.granted_at
                 FROM achievement_grants g
                 JOIN achievements a ON a.id = g.achievement_id
             ORDER BY g.granted_at DESC
             LIMIT $1 OFFSET $2"#,
        )
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
    }
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let grants = rows.into_iter().map(|r| r.into_grant()).collect();
    Ok(Json(grants))
}

// ---------------------------------------------------------------------------
// Admin: POST /api/v3/admin/achievements/{id}/grant
// ---------------------------------------------------------------------------

pub async fn admin_grant(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(achievement_id): Path<String>,
    Json(body): Json<AdminGrantBody>,
) -> Result<Json<AchievementGrant>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let _catalog = load_catalog(&state.pool, &achievement_id).await?;

    let row: GrantWithCatalogRow = sqlx::query_as(
        r#"WITH inserted AS (
             INSERT INTO achievement_grants
                 (user_id, achievement_id, source, source_id, reason, metadata)
             VALUES ($1, $2, 'admin', $3, $4, $5)
             ON CONFLICT (user_id, achievement_id) DO UPDATE
                 SET source = EXCLUDED.source,
                     source_id = EXCLUDED.source_id,
                     reason = EXCLUDED.reason,
                     metadata = EXCLUDED.metadata,
                     granted_at = EXCLUDED.granted_at
             RETURNING id as grant_id, user_id, achievement_id, source, source_id, reason, metadata, granted_at
           )
           SELECT
             a.id, a.name, a.description, a.icon, a.icon_url, a.category, a.points, a.secret,
             a.rarity, a.unlock_kind, a.unlock_config,
             i.grant_id, i.user_id, i.achievement_id, i.source, i.source_id, i.reason, i.metadata, i.granted_at
             FROM inserted i
             JOIN achievements a ON a.id = i.achievement_id"#,
    )
    .bind(body.user_id)
    .bind(&achievement_id)
    .bind(auth.user_id)
    .bind(body.reason.as_deref())
    .bind(body.metadata.as_ref())
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(row.into_grant()))
}

// ---------------------------------------------------------------------------
// Admin: DELETE /api/v3/admin/achievements/{id}/revoke/{user_id}
// ---------------------------------------------------------------------------

pub async fn admin_revoke(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((achievement_id, user_id)): Path<(String, Uuid)>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    sqlx::query(
        "DELETE FROM achievement_grants WHERE user_id = $1 AND achievement_id = $2",
    )
    .bind(user_id)
    .bind(&achievement_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

#[derive(Debug, FromRow)]
struct CatalogRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub icon_url: Option<String>,
    pub category: String,
    pub points: i32,
    pub secret: bool,
    pub rarity: String,
    pub unlock_kind: String,
    pub unlock_config: Option<Value>,
}

impl CatalogRow {
    fn into_catalog(self) -> AchievementCatalog {
        AchievementCatalog {
            id: self.id,
            category: self.category,
            title: self.name,
            description: self.description,
            icon_url: self.icon_url,
            rarity: Rarity::from_str(&self.rarity),
            unlock_criteria: UnlockCriteria::from_db(&self.unlock_kind, self.unlock_config),
            points: self.points as u32,
            secret: self.secret,
        }
    }
}

async fn load_catalog(
    pool: &sqlx::PgPool,
    achievement_id: &str,
) -> Result<CatalogRow, (StatusCode, String)> {
    sqlx::query_as::<_, CatalogRow>(
        "SELECT id, name, description, icon, icon_url, category, points, secret, rarity, unlock_kind, unlock_config \
         FROM achievements WHERE id = $1",
    )
    .bind(achievement_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "achievement not found".to_string()))
}

async fn grant_by_event(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    event: &str,
) -> Result<Option<AchievementCatalog>, sqlx::Error> {
    let catalog: Option<CatalogRow> = sqlx::query_as(
        "SELECT id, name, description, icon, icon_url, category, points, secret, rarity, unlock_kind, unlock_config \
         FROM achievements \
         WHERE unlock_kind = 'event' AND unlock_config->>'event' = $1",
    )
    .bind(event)
    .fetch_optional(pool)
    .await?;

    let Some(catalog) = catalog else {
        return Ok(None);
    };

    let id = catalog.id.clone();
    let result = catalog.into_catalog();

    sqlx::query(
        "INSERT INTO achievement_grants (user_id, achievement_id, source, reason) \
         VALUES ($1, $2, 'event', $3) \
         ON CONFLICT (user_id, achievement_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(&id)
    .bind(event)
    .execute(pool)
    .await?;

    Ok(Some(result))
}

/// Evaluate counter-based achievements for one user and return newly unlocked ids.
pub async fn evaluate_and_grant(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Vec<String>, sqlx::Error> {
    let row: (
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<String>,
        bool,
        bool,
        bool,
        bool,
        bool,
    ) = sqlx::query_as(
        r#"
        WITH msgs AS (
            SELECT COUNT(*) AS c FROM messages
             WHERE author_id = $1 AND chat_id IN (SELECT id FROM chats WHERE type = 'clan')
               AND deleted_at IS NULL
        ),
        dms AS (
            SELECT COUNT(*) AS c FROM messages
             WHERE author_id = $1 AND chat_id IN (SELECT id FROM chats WHERE type = 'dm')
               AND deleted_at IS NULL
        ),
        tpls_approved AS (
            SELECT COUNT(*) AS c FROM templates
             WHERE user_id = $1 AND scope = 'public' AND status = 'approved'
        ),
        tpls_any AS (
            SELECT COUNT(*) AS c FROM templates WHERE user_id = $1
        ),
        stats AS (
            SELECT pixels_placed AS c FROM user_stats WHERE user_id = $1
        ),
        clan_role AS (
            SELECT clan_role AS r FROM clan_memberships
             WHERE user_id = $1 AND active = TRUE
             ORDER BY CASE clan_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END
             LIMIT 1
        ),
        me AS (
            SELECT preferred_lang IS NOT NULL AS lang_set,
                   EXISTS(SELECT 1 FROM avatars WHERE user_id = $1) AS has_avatar,
                   vai_account_id IS NOT NULL AS has_vai,
                   telegram_user_id IS NOT NULL AS has_tg,
                   discord_id IS NOT NULL AS has_discord
              FROM users WHERE id = $1
        )
        SELECT COALESCE((SELECT c FROM msgs), 0)         AS msg_count,
               COALESCE((SELECT c FROM dms), 0)          AS dm_count,
               COALESCE((SELECT c FROM tpls_approved), 0)AS tpl_ok,
               COALESCE((SELECT c FROM tpls_any), 0)     AS tpl_total,
               (SELECT c FROM stats)                     AS pixels,
               (SELECT r FROM clan_role)                 AS clan_role,
               (SELECT lang_set FROM me)                 AS lang_set,
               (SELECT has_avatar FROM me)               AS has_avatar,
               (SELECT has_vai FROM me)                  AS has_vai,
               (SELECT has_tg FROM me)                   AS has_tg,
               (SELECT has_discord FROM me)              AS has_discord
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    let (msgs, dms, tpl_ok, tpl_total, pixels, clan_role, lang_set, has_avatar, has_vai, has_tg, has_discord) =
        row;

    let mut grant: Vec<&str> = Vec::new();
    let pixels = pixels.unwrap_or(0);
    if pixels >= 1 {
        grant.push("first_pixel");
    }
    if pixels >= 100 {
        grant.push("pixels_100");
    }
    if pixels >= 1000 {
        grant.push("pixels_1k");
    }
    if pixels >= 10_000 {
        grant.push("pixels_10k");
    }
    if tpl_total >= 1 {
        grant.push("first_template");
    }
    if tpl_ok >= 1 {
        grant.push("approved_template");
    }
    if tpl_ok >= 5 {
        grant.push("approved_5");
    }
    if clan_role.is_some() {
        grant.push("joined_clan");
    }
    if matches!(clan_role.as_deref(), Some("moderator") | Some("admin") | Some("owner")) {
        grant.push("clan_mod");
    }
    if dms >= 1 {
        grant.push("first_dm");
    }
    if msgs >= 100 {
        grant.push("clan_chat_100");
    }
    if lang_set {
        grant.push("multilingual");
    }
    if has_avatar {
        grant.push("avatar_uploaded");
    }
    if has_vai {
        grant.push("vai_linked");
    }
    if has_tg {
        grant.push("telegram_linked");
    }
    if has_discord {
        grant.push("discord_linked");
    }

    let mut newly: Vec<String> = Vec::new();
    for id in grant {
        let inserted: Option<Uuid> = sqlx::query_scalar(
            r#"INSERT INTO achievement_grants (user_id, achievement_id, source)
               VALUES ($1, $2, 'system')
               ON CONFLICT DO NOTHING
               RETURNING id"#,
        )
        .bind(user_id)
        .bind(id)
        .fetch_optional(pool)
        .await?;
        if inserted.is_some() {
            newly.push(id.to_string());
        }
    }
    Ok(newly)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{Rarity, UnlockCriteria};

    #[test]
    fn rarity_parsing() {
        assert_eq!(Rarity::from_str("common"), Rarity::Common);
        assert_eq!(Rarity::from_str("LEGENDARY"), Rarity::Legendary);
        assert_eq!(Rarity::from_str("unknown"), Rarity::Common);
    }

    #[test]
    fn unlock_criteria_from_db() {
        let cfg = serde_json::json!({"event": "found_the_dev"});
        let uc = UnlockCriteria::from_db("event", Some(cfg));
        match uc {
            UnlockCriteria::Event { event } => assert_eq!(event, "found_the_dev"),
            _ => panic!("expected event criteria"),
        }
    }

    #[test]
    fn unlock_criteria_counts() {
        let cfg = serde_json::json!({"count": 10});
        let uc = UnlockCriteria::from_db("achievement_count", Some(cfg));
        match uc {
            UnlockCriteria::AchievementCount { count } => assert_eq!(count, 10),
            _ => panic!("expected achievement_count criteria"),
        }
    }

    #[test]
    fn unlock_criteria_defaults_to_manual() {
        assert!(matches!(
            UnlockCriteria::from_db("weird", None),
            UnlockCriteria::Manual
        ));
    }
}
