//! V3 permission model — the authoritative two-axis role system.
//!
//! Global axis (`users.global_role`):
//!     user < moderator < admin < owner
//! Clan axis (`clan_memberships.clan_role` + `clans.owner_id`):
//!     member < moderator < admin < owner
//!
//! Both axes share the same ladder; only their scope differs. Predicates mean
//! "this rank or higher": `is_moderator()` is true for moderator/admin/owner,
//! `is_admin()` for admin/owner, `is_owner()` for owner alone.
//!
//! A user's *effective* authority inside a clan is the HIGHER of their actual
//! clan standing and the clan-equivalent of their global role — so a global
//! moderator moderates every clan, a global owner outranks every clan owner.
//!
//! This supersedes `routes::v2::permissions`, which lacked the global Moderator
//! tier and the clan Owner tier. V3 code must use this module.

use axum::http::StatusCode;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthUser;

// ---------------------------------------------------------------------------
// Global role
// ---------------------------------------------------------------------------

/// Ordered by authority — `derive(PartialOrd, Ord)` follows declaration order,
/// so `User < Moderator < Admin < Owner`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GlobalRole {
    User,
    Moderator,
    Admin,
    Owner,
}

#[allow(dead_code)] // some predicates are API surface used by later guards
impl GlobalRole {
    pub fn from_str(s: &str) -> GlobalRole {
        match s {
            "owner" => GlobalRole::Owner,
            "admin" => GlobalRole::Admin,
            "moderator" | "mod" => GlobalRole::Moderator,
            _ => GlobalRole::User,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            GlobalRole::Owner => "owner",
            GlobalRole::Admin => "admin",
            GlobalRole::Moderator => "moderator",
            GlobalRole::User => "user",
        }
    }
    /// Moderator or higher.
    pub fn is_moderator(self) -> bool {
        self >= GlobalRole::Moderator
    }
    /// Admin or higher.
    pub fn is_admin(self) -> bool {
        self >= GlobalRole::Admin
    }
    /// Owner (top of the ladder).
    pub fn is_owner(self) -> bool {
        self >= GlobalRole::Owner
    }
}

// ---------------------------------------------------------------------------
// Clan role
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClanRole {
    Member,
    Moderator,
    Admin,
    Owner,
}

#[allow(dead_code)]
impl ClanRole {
    pub fn from_str(s: &str) -> ClanRole {
        match s {
            "owner" => ClanRole::Owner,
            "admin" => ClanRole::Admin,
            "moderator" | "mod" => ClanRole::Moderator,
            _ => ClanRole::Member,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            ClanRole::Owner => "owner",
            ClanRole::Admin => "admin",
            ClanRole::Moderator => "moderator",
            ClanRole::Member => "member",
        }
    }
    /// The clan-scope equivalent of a global role, used to fold cross-clan
    /// authority into a single effective rank. Global `user` confers nothing.
    pub fn from_global(g: GlobalRole) -> Option<ClanRole> {
        match g {
            GlobalRole::Owner => Some(ClanRole::Owner),
            GlobalRole::Admin => Some(ClanRole::Admin),
            GlobalRole::Moderator => Some(ClanRole::Moderator),
            GlobalRole::User => None,
        }
    }
    pub fn is_moderator(self) -> bool {
        self >= ClanRole::Moderator
    }
    pub fn is_admin(self) -> bool {
        self >= ClanRole::Admin
    }
    pub fn is_owner(self) -> bool {
        self >= ClanRole::Owner
    }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

pub async fn global_role_of(pool: &PgPool, user_id: Uuid) -> Result<GlobalRole, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as("SELECT global_role FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .map(|r| GlobalRole::from_str(&r.0))
        .unwrap_or(GlobalRole::User))
}

/// The actor's *actual* standing inside the clan: `Owner` if they own it,
/// otherwise their active-membership role, otherwise `None` (not a member).
/// Does NOT fold in global roles — see `effective_clan_role` for that.
pub async fn clan_role_of(
    pool: &PgPool,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<Option<ClanRole>, sqlx::Error> {
    let owner: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT owner_id FROM clans WHERE id = $1")
            .bind(clan_id)
            .fetch_optional(pool)
            .await?;
    if let Some((Some(owner_id),)) = owner {
        if owner_id == user_id {
            return Ok(Some(ClanRole::Owner));
        }
    }
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT clan_role FROM clan_memberships WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
    )
    .bind(user_id)
    .bind(clan_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ClanRole::from_str(&r.0)))
}

/// Effective authority inside the clan = the higher of the actor's actual clan
/// role and the clan-equivalent of their global role.
pub async fn effective_clan_role(
    pool: &PgPool,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<Option<ClanRole>, sqlx::Error> {
    let g = global_role_of(pool, user_id).await?;
    let actual = clan_role_of(pool, user_id, clan_id).await?;
    let global_equiv = ClanRole::from_global(g);
    Ok(match (actual, global_equiv) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    })
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub async fn require_moderator(
    auth: &AuthUser,
    pool: &PgPool,
) -> Result<(), (StatusCode, String)> {
    let g = global_role_of(pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !g.is_moderator() {
        return Err((StatusCode::FORBIDDEN, "moderator only".into()));
    }
    Ok(())
}

#[allow(dead_code)]
pub async fn require_admin(auth: &AuthUser, pool: &PgPool) -> Result<(), (StatusCode, String)> {
    let g = global_role_of(pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !g.is_admin() {
        return Err((StatusCode::FORBIDDEN, "admin only".into()));
    }
    Ok(())
}

/// Actor must be a clan moderator or higher (folding in global authority).
#[allow(dead_code)]
pub async fn require_clan_mod(
    auth: &AuthUser,
    pool: &PgPool,
    clan_id: Uuid,
) -> Result<ClanRole, (StatusCode, String)> {
    let r = effective_clan_role(pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::FORBIDDEN, "not in clan".into()))?;
    if !r.is_moderator() {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".into()));
    }
    Ok(r)
}

/// Actor must be a clan admin or higher (folding in global authority).
#[allow(dead_code)]
pub async fn require_clan_admin(
    auth: &AuthUser,
    pool: &PgPool,
    clan_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    let r = effective_clan_role(pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::FORBIDDEN, "not in clan".into()))?;
    if !r.is_admin() {
        return Err((StatusCode::FORBIDDEN, "clan admin required".into()));
    }
    Ok(())
}

/// Auto-approval bypass for user-published content:
///   - global admin/owner publishes anything pre-approved;
///   - the extension author ("vai", case-insensitive) gets the same;
///   - clan-scoped publishes are pre-approved for that clan's moderators+;
///   - everything else lands as 'pending'.
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
    let Some((username, role)) = row else {
        return Ok(false);
    };
    if GlobalRole::from_str(&role).is_admin() || username.trim().eq_ignore_ascii_case("vai") {
        return Ok(true);
    }
    if scope == "clan" {
        if let Some(cid) = clan_id {
            return Ok(effective_clan_role(pool, user_id, cid)
                .await?
                .map(|r| r.is_moderator())
                .unwrap_or(false));
        }
    }
    Ok(false)
}
