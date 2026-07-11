//! WallAnim config storage + sharing (/api/v2/anim-configs).
//!
//! The config document is the client's `wall-anim/1` JSON, stored verbatim as
//! JSONB. Visibility: `private` (owner), `clan` (active members of clan_id),
//! `public`. Sharing with a clan requires being an active member; mutating
//! someone else's config requires clan moderator (same clan) or global admin.
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions;
use crate::{
    AppState,
    auth::{AuthUser, hash_token, verify_token},
};

/// Hard cap for the JSON document. WallAnim configs are tiny (URLs + numbers);
/// anything bigger is someone stuffing a data URL into `sources`, which the
/// backend stores fine — but bound it to keep rows sane.
const MAX_CONFIG_BYTES: usize = 512 * 1024;

#[derive(Debug, Serialize, FromRow)]
pub struct AnimConfigRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub clan_id: Option<Uuid>,
    pub scope: String,
    /// Same approval workflow as classic templates: pending|approved|rejected,
    /// with the shared auto-approve bypass on create.
    pub status: String,
    pub pinned: bool,
    pub name: String,
    pub config: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

const ANIM_COLS: &str =
    "id, user_id, clan_id, scope, status, pinned, name, config, created_at, updated_at";

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub config: serde_json::Value,
    /// 'private' (default) | 'clan' | 'public'
    pub scope: Option<String>,
    pub clan_id: Option<Uuid>,
    /// Optional share password for private configs: anyone with the link AND
    /// this password can fetch the config via GET /{id}/shared?pass=… without
    /// being the owner. Only the SHA-256 hash is stored.
    pub access_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// Optional filter: only this clan's shared configs.
    pub clan_id: Option<Uuid>,
}

fn validate_scope(scope: &str, clan_id: Option<Uuid>) -> Result<(), (StatusCode, String)> {
    match scope {
        "private" | "public" => Ok(()),
        "clan" if clan_id.is_some() => Ok(()),
        "clan" => Err((StatusCode::BAD_REQUEST, "clan scope needs clan_id".into())),
        _ => Err((StatusCode::BAD_REQUEST, "scope must be private|clan|public".into())),
    }
}

async fn check_share_rights(
    state: &AppState,
    user_id: Uuid,
    scope: &str,
    clan_id: Option<Uuid>,
) -> Result<(), (StatusCode, String)> {
    if scope == "clan" {
        let cid = clan_id.unwrap();
        let role = permissions::effective_clan_role(&state.pool, user_id, cid)
            .await
            .or_500()?;
        if role.is_none() {
            return Err((StatusCode::FORBIDDEN, "not a member of that clan".into()));
        }
    }
    Ok(())
}

/// Everything the caller can see: own + their clans' shared + public.
pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<AnimConfigRow>>, (StatusCode, String)> {
    // Others' shared configs surface only once approved (pinned float to the
    // top, classic-board style); your own rows are always visible.
    let rows = sqlx::query_as::<_, AnimConfigRow>(&format!(
        r#"SELECT {ANIM_COLS}
             FROM anim_configs
            WHERE (user_id = $1
                   OR ((scope = 'public'
                        OR (scope = 'clan' AND clan_id IN (
                             SELECT clan_id FROM clan_memberships
                              WHERE user_id = $1 AND active = TRUE)))
                       AND status = 'approved'))
              AND ($2::uuid IS NULL OR clan_id = $2)
            ORDER BY pinned DESC, updated_at DESC
            LIMIT 200"#,
    ))
    .bind(auth.user_id)
    .bind(q.clan_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(b): Json<CreateBody>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    let name = b.name.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "name required".into()));
    }
    let raw = serde_json::to_vec(&b.config).unwrap_or_default();
    if raw.len() > MAX_CONFIG_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "config too large".into()));
    }
    // The document is our standard export envelope with an animation block —
    // same format the extension already uses for static template sharing.
    if b.config.get("format").and_then(|f| f.as_str()) != Some("the-wall-dev/1") {
        return Err((StatusCode::BAD_REQUEST, "config.format must be the-wall-dev/1".into()));
    }
    if b.config.pointer("/template/animation").is_none() {
        return Err((StatusCode::BAD_REQUEST, "config.template.animation missing".into()));
    }
    let scope = b.scope.as_deref().unwrap_or("private");
    validate_scope(scope, b.clan_id)?;
    check_share_rights(&state, auth.user_id, scope, b.clan_id).await?;

    let pass_hash = b
        .access_password
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(hash_token);
    // Same approval rule as classic templates (shared bypass helper):
    // private is yours alone → approved; clan/public land pending unless the
    // caller is a global admin / VAI / mod of the target clan.
    let status = if scope == "private"
        || permissions::publish_auto_approved(&state.pool, auth.user_id, scope, b.clan_id)
            .await
            .or_500()?
    {
        "approved"
    } else {
        "pending"
    };
    let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
        r#"INSERT INTO anim_configs (user_id, clan_id, scope, status, name, config, access_password_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING {ANIM_COLS}"#,
    ))
    .bind(auth.user_id)
    .bind(if scope == "clan" { b.clan_id } else { None })
    .bind(scope)
    .bind(status)
    .bind(name)
    .bind(&b.config)
    .bind(pass_hash)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

/* ----------------------- approval / pin workflow ------------------------- */

/// Approve/reject rights mirror regions: clan scope → clan mod/admin (or
/// global admin); public scope → global admin only.
async fn can_review(
    state: &AppState,
    auth: &AuthUser,
    scope: &str,
    clan: Option<Uuid>,
) -> Result<bool, (StatusCode, String)> {
    let g = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .or_500()?;
    if g.is_admin() {
        return Ok(true);
    }
    if scope == "clan" {
        if let Some(cid) = clan {
            let role = permissions::effective_clan_role(&state.pool, auth.user_id, cid)
                .await
                .or_500()?;
            return Ok(role.map(|r| r.is_mod()).unwrap_or(false));
        }
    }
    Ok(false)
}

async fn set_status(
    auth: AuthUser,
    state: &AppState,
    id: Uuid,
    new_status: &str,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    let existing: Option<(String, Option<Uuid>)> =
        sqlx::query_as("SELECT scope, clan_id FROM anim_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (scope, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if scope == "private" {
        return Err((StatusCode::BAD_REQUEST, "private configs need no approval".into()));
    }
    if !can_review(state, &auth, &scope, clan).await? {
        return Err((StatusCode::FORBIDDEN, "approver role required".into()));
    }
    let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
        "UPDATE anim_configs SET status = $2, updated_at = now() WHERE id = $1 RETURNING {ANIM_COLS}",
    ))
    .bind(id)
    .bind(new_status)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

pub async fn approve(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    set_status(auth, &state, id, "approved").await
}

pub async fn reject(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    set_status(auth, &state, id, "rejected").await
}

async fn set_pinned(
    auth: AuthUser,
    state: &AppState,
    id: Uuid,
    pinned: bool,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    let existing: Option<(String, Option<Uuid>)> =
        sqlx::query_as("SELECT scope, clan_id FROM anim_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (scope, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if !can_review(state, &auth, &scope, clan).await? {
        return Err((StatusCode::FORBIDDEN, "mod role required".into()));
    }
    let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
        "UPDATE anim_configs SET pinned = $2, updated_at = now() WHERE id = $1 RETURNING {ANIM_COLS}",
    ))
    .bind(id)
    .bind(pinned)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

pub async fn pin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    set_pinned(auth, &state, id, true).await
}

pub async fn unpin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    set_pinned(auth, &state, id, false).await
}

/* --------------------------- shared access ------------------------------- */

#[derive(Debug, Deserialize)]
pub struct SharedQuery {
    pub pass: Option<String>,
}

/// Fetch one config through a share link. Access order:
///   1. correct `?pass=` → granted, even for private configs, no auth needed;
///   2. otherwise a valid session that passes the normal visibility rules
///      (owner / approved clan member / public).
/// Auth here is OPTIONAL by design — axum's `Option<AuthUser>` would still
/// reject a malformed header, so we parse the Bearer token by hand.
pub async fn shared(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<SharedQuery>,
    headers: HeaderMap,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    // Path 1: password.
    if let Some(pass) = q.pass.as_deref().filter(|p| !p.is_empty()) {
        let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
            "SELECT {ANIM_COLS} FROM anim_configs WHERE id = $1 AND access_password_hash = $2",
        ))
        .bind(id)
        .bind(hash_token(pass))
        .fetch_optional(&state.pool)
        .await
        .or_500()?;
        if let Some(row) = row {
            return Ok(Json(row));
        }
        // Wrong password falls through to the session path rather than
        // erroring early — a logged-in owner with a stale link still wins.
    }

    // Path 2: session.
    let user_id = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .and_then(|tok| verify_token(tok, &state.config.jwt_secret).ok())
        .and_then(|c| Uuid::parse_str(&c.sub).ok());
    let Some(user_id) = user_id else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };
    let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
        r#"SELECT {ANIM_COLS} FROM anim_configs
            WHERE id = $2
              AND (user_id = $1
                   OR scope = 'public'
                   OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $1 AND active = TRUE)))"#,
    ))
    .bind(user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?
    .ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub config: Option<serde_json::Value>,
    pub scope: Option<String>,
    pub clan_id: Option<Uuid>,
}

/// Owner, clan moderator (for clan-scoped rows), or global admin.
async fn can_mutate(
    state: &AppState,
    auth: &AuthUser,
    row_owner: Uuid,
    row_clan: Option<Uuid>,
) -> Result<bool, (StatusCode, String)> {
    if row_owner == auth.user_id {
        return Ok(true);
    }
    let g = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .or_500()?;
    if g.is_admin() {
        return Ok(true);
    }
    if let Some(cid) = row_clan {
        let role = permissions::effective_clan_role(&state.pool, auth.user_id, cid)
            .await
            .or_500()?;
        return Ok(role.map(|r| r.is_mod()).unwrap_or(false));
    }
    Ok(false)
}

pub async fn update(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<AnimConfigRow>, (StatusCode, String)> {
    let existing: Option<(Uuid, Option<Uuid>)> =
        sqlx::query_as("SELECT user_id, clan_id FROM anim_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (owner, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if !can_mutate(&state, &auth, owner, clan).await? {
        return Err((StatusCode::FORBIDDEN, "owner / clan mod required".into()));
    }
    if let Some(cfg) = &b.config {
        if serde_json::to_vec(cfg).unwrap_or_default().len() > MAX_CONFIG_BYTES {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "config too large".into()));
        }
    }
    if let Some(scope) = &b.scope {
        validate_scope(scope, b.clan_id.or(clan))?;
        check_share_rights(&state, auth.user_id, scope, b.clan_id.or(clan)).await?;
    }

    let row = sqlx::query_as::<_, AnimConfigRow>(&format!(
        r#"UPDATE anim_configs SET
               name       = COALESCE($2, name),
               config     = COALESCE($3, config),
               scope      = COALESCE($4, scope),
               clan_id    = COALESCE($5, clan_id),
               updated_at = now()
           WHERE id = $1
           RETURNING {ANIM_COLS}"#,
    ))
    .bind(id)
    .bind(b.name.as_deref().map(str::trim))
    .bind(&b.config)
    .bind(&b.scope)
    .bind(b.clan_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;
    Ok(Json(row))
}

pub async fn remove(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    let existing: Option<(Uuid, Option<Uuid>)> =
        sqlx::query_as("SELECT user_id, clan_id FROM anim_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;
    let (owner, clan) = existing.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;
    if !can_mutate(&state, &auth, owner, clan).await? {
        return Err((StatusCode::FORBIDDEN, "owner / clan mod required".into()));
    }
    sqlx::query("DELETE FROM anim_configs WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .or_500()?;
    Ok(StatusCode::NO_CONTENT)
}
