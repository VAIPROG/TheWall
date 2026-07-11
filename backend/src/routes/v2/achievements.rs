//! Achievements & badges.
//!
//! The catalogue lives in the `achievements` table (seeded by migration 004).
//! Unlocks land in `user_achievements`. We expose:
//!
//!   GET /api/v2/achievements                — list everything (hides secrets the
//!                                              caller hasn't unlocked)
//!   GET /api/v2/users/:id/achievements      — what someone's earned
//!   POST /api/v2/me/achievements/recheck    — re-evaluate from current stats
//!
//! The evaluator below runs counter-based criteria from DB state. Call it
//! after any meaningful event (template approved, message posted, …) — it's
//! idempotent so duplicates are fine.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Serialize;
use crate::http_error::ResultExt;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

use super::permissions;

#[derive(Debug, Serialize, FromRow)]
pub struct AchievementRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub points: i32,
    pub secret: bool,
    pub unlocked_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list_for_me(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<AchievementRow>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, AchievementRow>(
        r#"SELECT a.id, a.name, a.description, a.icon, a.category, a.points, a.secret,
                  ua.unlocked_at
             FROM achievements a
        LEFT JOIN user_achievements ua
               ON ua.achievement_id = a.id AND ua.user_id = $1
            WHERE (NOT a.secret) OR ua.unlocked_at IS NOT NULL
            ORDER BY a.category, a.points DESC, a.id"#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

pub async fn list_for_user(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Vec<AchievementRow>>, (StatusCode, String)> {
    // For public viewers we show ONLY unlocked, no secrets revealed.
    let rows = sqlx::query_as::<_, AchievementRow>(
        r#"SELECT a.id, a.name, a.description, a.icon, a.category, a.points, a.secret,
                  ua.unlocked_at
             FROM user_achievements ua
             JOIN achievements a ON a.id = ua.achievement_id
            WHERE ua.user_id = $1
            ORDER BY ua.unlocked_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

pub async fn recheck_me(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let unlocked = evaluate(&state.pool, auth.user_id)
        .await
        .or_500()?;
    Ok(Json(serde_json::json!({ "newly_unlocked": unlocked })))
}

/// Evaluate every counter-based achievement for one user. Returns the list
/// of achievement ids that got newly granted. Safe to call repeatedly.
pub async fn evaluate(pool: &PgPool, user_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
    // Gather all the counters we need in one shot.
    let row: (
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<String>,
        bool,
        bool,
        bool,
        bool,
    ) = sqlx::query_as(
        r#"
        WITH msgs AS (
            SELECT COUNT(*) AS c FROM clan_messages WHERE user_id = $1
        ),
        dms AS (
            SELECT COUNT(*) AS c FROM mailbox_items
             WHERE kind = 'dm' AND sender_id = $1
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
             ORDER BY CASE clan_role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END
             LIMIT 1
        ),
        me AS (
            SELECT preferred_lang IS NOT NULL AS lang_set,
                   EXISTS(SELECT 1 FROM avatars WHERE user_id = $1) AS has_avatar,
                   vai_account_id IS NOT NULL AS has_vai,
                   telegram_user_id IS NOT NULL AS has_tg
              FROM users WHERE id = $1
        )
        SELECT (SELECT COALESCE(c,0) FROM msgs)         AS msg_count,
               (SELECT COALESCE(c,0) FROM dms)          AS dm_count,
               (SELECT COALESCE(c,0) FROM tpls_approved)AS tpl_ok,
               (SELECT COALESCE(c,0) FROM tpls_any)     AS tpl_total,
               (SELECT COALESCE(c,0) FROM stats)        AS pixels,
               (SELECT r FROM clan_role)                AS clan_role,
               (SELECT lang_set FROM me)                AS lang_set,
               (SELECT has_avatar FROM me)              AS has_avatar,
               (SELECT has_vai FROM me)                 AS has_vai,
               (SELECT has_tg FROM me)                  AS has_tg
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let (msgs, dms, tpl_ok, tpl_total, pixels, clan_role, lang_set, has_avatar, has_vai, has_tg) =
        row;

    let mut grant: Vec<&str> = Vec::new();
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
    if matches!(clan_role.as_deref(), Some("moderator") | Some("admin")) {
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

    let mut newly: Vec<String> = Vec::new();
    for id in grant {
        let inserted: Option<(String,)> = sqlx::query_as(
            r#"INSERT INTO user_achievements (user_id, achievement_id)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING
               RETURNING achievement_id"#,
        )
        .bind(user_id)
        .bind(id)
        .fetch_optional(pool)
        .await?;
        if let Some(x) = inserted {
            newly.push(x.0);
        }
    }
    Ok(newly)
}

// ---------------------------------------------------------------------------
// Event-based grants
// ---------------------------------------------------------------------------

/// Grant a single achievement to the user if they don't have it yet. Returns
/// the achievement row (with `unlocked_at = NOW()` on first grant, or the
/// pre-existing timestamp on a repeat call).
async fn grant_one(
    pool: &PgPool,
    user_id: Uuid,
    achievement_id: &str,
) -> Result<Option<AchievementRow>, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO user_achievements (user_id, achievement_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(user_id)
    .bind(achievement_id)
    .execute(pool)
    .await?;

    sqlx::query_as::<_, AchievementRow>(
        r#"SELECT a.id, a.name, a.description, a.icon, a.category, a.points, a.secret,
                  ua.unlocked_at
             FROM achievements a
        LEFT JOIN user_achievements ua
               ON ua.achievement_id = a.id AND ua.user_id = $1
            WHERE a.id = $2"#,
    )
    .bind(user_id)
    .bind(achievement_id)
    .fetch_optional(pool)
    .await
}

/// Wraps `grant_one` and tells the caller whether the grant was new.
#[derive(Debug, Serialize)]
pub struct GrantResult {
    pub achievement: AchievementRow,
    pub was_new: bool,
}

async fn grant_with_diff(
    pool: &PgPool,
    user_id: Uuid,
    achievement_id: &str,
) -> Result<Option<GrantResult>, sqlx::Error> {
    // Was the user holding it already?
    let existed: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(SELECT 1 FROM user_achievements
                          WHERE user_id = $1 AND achievement_id = $2)"#,
    )
    .bind(user_id)
    .bind(achievement_id)
    .fetch_one(pool)
    .await?;

    let row = grant_one(pool, user_id, achievement_id).await?;
    Ok(row.map(|r| GrantResult { achievement: r, was_new: !existed }))
}

/// POST /api/v2/me/achievements/found-the-dev
///
/// Granted whenever any authed user views VAI's profile through the
/// extension. Repeat calls are no-ops (insert ignores conflicts) but the
/// response always carries the achievement row so the client can render the
/// unlock toast on the first call and silently absorb the rest.
pub async fn grant_found_the_dev(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<GrantResult>, (StatusCode, String)> {
    grant_with_diff(&state.pool, auth.user_id, "found_the_dev")
        .await
        .or_500()?
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "achievement seed missing — run migration 015".into(),
            )
        })
}

#[derive(Debug, serde::Deserialize)]
pub struct EventBody {
    pub event: Option<String>,
}

/// POST /api/v2/me/achievements/event
///
/// Generic hook for client-fired UX events that map onto an achievement.
/// Currently recognised events:
///   `emote_explorer`       — user sent a chat message containing a 7TV emote
///   `snapshot_viewer`      — opened the snapshot feed
///   `compact_mode_enabled` — switched the overlay to compact markers
///   `precise_place`        — placed a pixel via Deep Integration
///   `first_pinned`         — pinned a template to their profile
///   `extension_installed`  — finished the first backend handshake
///   `profile_complete`     — saved a profile with bio + ≥1 social link
///
/// Unknown events are silently rejected with 200 + new=false so the client
/// can ship new event names without coordinating a backend deploy.
pub async fn grant_event(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<EventBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    const ALLOWED: &[&str] = &[
        "emote_explorer",
        "snapshot_viewer",
        "compact_mode_enabled",
        "precise_place",
        "first_pinned",
        "extension_installed",
        "profile_complete",
        "vai_pinged",
    ];
    let event = body.event.unwrap_or_default();
    if !ALLOWED.contains(&event.as_str()) {
        return Ok(Json(serde_json::json!({ "new": false, "ignored": true })));
    }
    let grant = grant_with_diff(&state.pool, auth.user_id, &event)
        .await
        .or_500()?;
    Ok(Json(serde_json::json!({
        "new": grant.as_ref().map(|g| g.was_new).unwrap_or(false),
        "achievement": grant.map(|g| g.achievement),
    })))
}

// ---------------------------------------------------------------------------
// Admin grant / revoke
// ---------------------------------------------------------------------------

/// Body shape for the username-based grant/revoke endpoints. The admin UI
/// usually has a username at hand (it's printed in roster lists and chat),
/// so accepting it directly saves a round-trip through the user-search API.
#[derive(Debug, serde::Deserialize)]
pub struct AdminByNameBody {
    pub username: String,
}

/// Resolve a username to a user id. Case-insensitive match — the site stores
/// usernames lowercased but other call paths sometimes pass mixed case.
async fn resolve_username(pool: &PgPool, name: &str) -> Result<Uuid, (StatusCode, String)> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "username is empty".into()));
    }
    let row: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
    )
    .bind(trimmed)
    .fetch_optional(pool)
    .await
    .or_500()?;
    row.ok_or_else(|| (StatusCode::NOT_FOUND, format!("no such user: {trimmed}")))
}

/// POST /api/v2/admin/achievements/grant-by-username
/// Body: `{ username, achievement_id }`. Looks up the user by name then
/// delegates to the same grant path as admin_grant().
pub async fn admin_grant_by_name(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(achievement_id): Path<String>,
    Json(body): Json<AdminByNameBody>,
) -> Result<Json<GrantResult>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let user_id = resolve_username(&state.pool, &body.username).await?;
    let result = grant_with_diff(&state.pool, user_id, &achievement_id)
        .await
        .or_500()?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "no such achievement".into()))?;
    if result.was_new && achievement_id != "owner_blessed" {
        let _ = grant_one(&state.pool, user_id, "owner_blessed").await;
    }
    tracing::info!(
        "admin {} granted '{}' to {} (={}) via username='{}' (new={})",
        auth.user_id, achievement_id, user_id, body.username, body.username, result.was_new,
    );
    Ok(Json(result))
}

/// DELETE /api/v2/admin/achievements/{achievement_id}/by-username/{username}
pub async fn admin_revoke_by_name(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((achievement_id, username)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let user_id = resolve_username(&state.pool, &username).await?;
    let res = sqlx::query(
        "DELETE FROM user_achievements WHERE user_id = $1 AND achievement_id = $2",
    )
    .bind(user_id)
    .bind(&achievement_id)
    .execute(&state.pool)
    .await
    .or_500()?;
    tracing::info!(
        "admin {} revoked '{}' from {}={} (rows={})",
        auth.user_id, achievement_id, username, user_id, res.rows_affected(),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v2/admin/users/{user_id}/achievements/{achievement_id}
pub async fn admin_grant(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((user_id, achievement_id)): Path<(Uuid, String)>,
) -> Result<Json<GrantResult>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let result = grant_with_diff(&state.pool, user_id, &achievement_id)
        .await
        .or_500()?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "no such achievement".into()))?;
    // If this was the first-ever award, also unlock the "owner_blessed" badge
    // so admin gifts feel a little extra.
    if result.was_new && achievement_id != "owner_blessed" {
        let _ = grant_one(&state.pool, user_id, "owner_blessed").await;
    }
    tracing::info!(
        "admin {} granted achievement {} to user {} (new={})",
        auth.user_id, achievement_id, user_id, result.was_new
    );
    Ok(Json(result))
}

/// DELETE /api/v2/admin/users/{user_id}/achievements/{achievement_id}
pub async fn admin_revoke(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((user_id, achievement_id)): Path<(Uuid, String)>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let res = sqlx::query(
        "DELETE FROM user_achievements WHERE user_id = $1 AND achievement_id = $2",
    )
    .bind(user_id)
    .bind(&achievement_id)
    .execute(&state.pool)
    .await
    .or_500()?;
    tracing::info!(
        "admin {} revoked achievement {} from user {} (rows={})",
        auth.user_id, achievement_id, user_id, res.rows_affected()
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateAchievementBody {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub points: i32,
    pub secret: bool,
}

/// POST /api/v2/admin/achievements — create a new catalogue entry on the fly.
///
/// `id` must be lowercase snake_case (a–z, 0–9, _). Duplicate ids return 409
/// so the admin UI can show a clear error. The icon name maps to our SVG
/// library in `src/icons.ts`; unknown names render the star fallback so a
/// new achievement never produces a broken-image block.
pub async fn admin_create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateAchievementBody>,
) -> Result<Json<AchievementRow>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;

    let id = body.id.trim().to_string();
    if id.is_empty()
        || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "id must be lowercase snake_case (a-z, 0-9, _)".into(),
        ));
    }
    if body.name.trim().is_empty() || body.description.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "name and description are required".into(),
        ));
    }
    if body.points < 0 || body.points > 10_000 {
        return Err((StatusCode::BAD_REQUEST, "points out of range (0..=10000)".into()));
    }

    let insert = sqlx::query(
        r#"INSERT INTO achievements (id, name, description, icon, category, points, secret)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(&id)
    .bind(body.name.trim())
    .bind(body.description.trim())
    .bind(&body.icon)
    .bind(&body.category)
    .bind(body.points)
    .bind(body.secret)
    .execute(&state.pool)
    .await;

    if let Err(e) = insert {
        // Postgres unique-violation lands here as 23505. Surface as 409.
        if let Some(db_err) = e.as_database_error() {
            if db_err.code().as_deref() == Some("23505") {
                return Err((StatusCode::CONFLICT, format!("achievement '{id}' already exists")));
            }
        }
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }

    let row = sqlx::query_as::<_, AchievementRow>(
        r#"SELECT id, name, description, icon, category, points, secret,
                  NULL::timestamptz AS unlocked_at
             FROM achievements WHERE id = $1"#,
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    tracing::info!(
        "admin {} created achievement {} (name='{}', points={})",
        auth.user_id, id, row.name, row.points
    );
    Ok(Json(row))
}

/// GET /api/v2/admin/achievements — full catalogue for the admin grant UI.
pub async fn admin_list_catalogue(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<AchievementRow>>, (StatusCode, String)> {
    permissions::require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, AchievementRow>(
        r#"SELECT id, name, description, icon, category, points, secret,
                  NULL::timestamptz AS unlocked_at
             FROM achievements
            ORDER BY category, points DESC, id"#,
    )
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}
