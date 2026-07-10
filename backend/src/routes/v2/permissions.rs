//! Two-axis permission helpers.
//!
//! Global role (on `users.global_role`):  user < admin < owner
//! Clan role   (on `clan_memberships.clan_role`): member < moderator < admin
//!
//! A `global=admin` short-circuits every clan permission check: admins see and
//! moderate everything across every clan. `owner` is the same as `admin` for
//! checks, but is additionally protected (cannot be deleted/demoted; only
//! one exists per install).

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GlobalRole {
    User,
    Admin,
    Owner,
}

#[allow(dead_code)] // is_owner/as_str: API surface, used by future owner-guard
impl GlobalRole {
    pub fn from_str(s: &str) -> GlobalRole {
        match s {
            "owner" => GlobalRole::Owner,
            "admin" => GlobalRole::Admin,
            _ => GlobalRole::User,
        }
    }
    pub fn is_admin(self) -> bool {
        matches!(self, GlobalRole::Admin | GlobalRole::Owner)
    }
    pub fn is_owner(self) -> bool {
        matches!(self, GlobalRole::Owner)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            GlobalRole::Owner => "owner",
            GlobalRole::Admin => "admin",
            GlobalRole::User => "user",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClanRole {
    Member,
    Moderator,
    Admin,
}

impl ClanRole {
    pub fn from_str(s: &str) -> ClanRole {
        match s {
            "admin" => ClanRole::Admin,
            "moderator" | "mod" => ClanRole::Moderator,
            _ => ClanRole::Member,
        }
    }
    pub fn is_mod(self) -> bool {
        matches!(self, ClanRole::Moderator | ClanRole::Admin)
    }
    pub fn is_admin(self) -> bool {
        matches!(self, ClanRole::Admin)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            ClanRole::Admin => "admin",
            ClanRole::Moderator => "moderator",
            ClanRole::Member => "member",
        }
    }
}

pub async fn global_role_of(pool: &PgPool, user_id: Uuid) -> Result<GlobalRole, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as("SELECT global_role FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .map(|r| GlobalRole::from_str(&r.0))
        .unwrap_or(GlobalRole::User))
}

/// Look up the auth user's clan_role inside a specific clan, falling back to
/// `None` if they aren't a member or the membership is inactive.
pub async fn clan_role_of(
    pool: &PgPool,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<Option<ClanRole>, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT clan_role FROM clan_memberships WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
    )
    .bind(user_id)
    .bind(clan_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ClanRole::from_str(&r.0)))
}

/// Effective in-clan permission for an actor: their clan role, or
/// "as good as clan_admin" if they're a global admin/owner.
pub async fn effective_clan_role(
    pool: &PgPool,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<Option<ClanRole>, sqlx::Error> {
    let g = global_role_of(pool, user_id).await?;
    if g.is_admin() {
        return Ok(Some(ClanRole::Admin));
    }
    clan_role_of(pool, user_id, clan_id).await
}

/// Guard: return early with 403 unless the user is a global admin/owner.
pub async fn require_admin(
    auth: &AuthUser,
    pool: &PgPool,
) -> Result<(), (axum::http::StatusCode, String)> {
    let g = global_role_of(pool, auth.user_id)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !g.is_admin() {
        return Err((axum::http::StatusCode::FORBIDDEN, "admin only".into()));
    }
    Ok(())
}

/// Guard: actor must be a clan moderator (or higher), or a global admin.
pub async fn require_clan_mod(
    auth: &AuthUser,
    pool: &PgPool,
    clan_id: Uuid,
) -> Result<ClanRole, (axum::http::StatusCode, String)> {
    let r = effective_clan_role(pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((axum::http::StatusCode::FORBIDDEN, "not in clan".into()))?;
    if !r.is_mod() {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            "clan moderator required".into(),
        ));
    }
    Ok(r)
}

/// Guard: actor must be a clan admin, or a global admin.
pub async fn require_clan_admin(
    auth: &AuthUser,
    pool: &PgPool,
    clan_id: Uuid,
) -> Result<(), (axum::http::StatusCode, String)> {
    let r = effective_clan_role(pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((axum::http::StatusCode::FORBIDDEN, "not in clan".into()))?;
    if !r.is_admin() {
        return Err((
            axum::http::StatusCode::FORBIDDEN,
            "clan admin required".into(),
        ));
    }
    Ok(())
}

/// Shared auto-approval bypass for user-published content — classic
/// templates, animated-template configs, and protected regions all use the
/// same rule, so it lives here instead of being copy-pasted per route:
///
///   - global admin/owner publishes anything pre-approved;
///   - clan-scoped publishes are pre-approved for that clan's
///     moderators/admins;
///   - everything else lands as 'pending' for review.
pub async fn publish_auto_approved(
    pool: &PgPool,
    user_id: Uuid,
    scope: &str,
    clan_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT username, global_role FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let Some((_, role)) = row else {
        return Ok(false);
    };
    if GlobalRole::from_str(&role).is_admin() {
        return Ok(true);
    }
    if scope == "clan" {
        if let Some(cid) = clan_id {
            return Ok(effective_clan_role(pool, user_id, cid)
                .await?
                .map(|r| r.is_mod())
                .unwrap_or(false));
        }
    }
    Ok(false)
}
