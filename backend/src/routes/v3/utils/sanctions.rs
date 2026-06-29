//! Active-restriction enforcement helpers.
//!
//! These functions are the enforcement layer for the V3 sanctions system.
//! Call `ensure_not_sanctioned` in any handler that should respect restrictions.

use axum::http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::RestrictionRow;

// ---------------------------------------------------------------------------
// Sanction enum
// ---------------------------------------------------------------------------

/// Identifies which `s_*` column to check for a sanction.
#[allow(dead_code)]
pub enum Sanction {
    Mute,
    Ban,
    PublishTemplates,
    InviteToClan,
    SendReports,
    SendModmail,
}

impl Sanction {
    /// Human-readable past-tense description for 403 messages.
    fn label(&self) -> &'static str {
        match self {
            Sanction::Mute => "muted",
            Sanction::Ban => "banned",
            Sanction::PublishTemplates => "restricted from publishing templates",
            Sanction::InviteToClan => "restricted from inviting to clans",
            Sanction::SendReports => "restricted from sending reports",
            Sanction::SendModmail => "restricted from sending modmail",
        }
    }

    /// Returns the column name for this sanction.
    fn column(&self) -> &'static str {
        match self {
            Sanction::Mute => "s_mute",
            Sanction::Ban => "s_ban",
            Sanction::PublishTemplates => "s_publish_templates",
            Sanction::InviteToClan => "s_invite_to_clan",
            Sanction::SendReports => "s_send_reports",
            Sanction::SendModmail => "s_send_modmail",
        }
    }

    /// Returns the boolean column value on a restriction row.
    fn flag_on(&self, row: &RestrictionRow) -> bool {
        match self {
            Sanction::Mute => row.s_mute,
            Sanction::Ban => row.s_ban,
            Sanction::PublishTemplates => row.s_publish_templates,
            Sanction::InviteToClan => row.s_invite_to_clan,
            Sanction::SendReports => row.s_send_reports,
            Sanction::SendModmail => row.s_send_modmail,
        }
    }
}

// ---------------------------------------------------------------------------
// Active restrictions
// ---------------------------------------------------------------------------

/// Returns all active (not removed, not expired) restrictions for a user.
pub async fn active_restrictions(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<RestrictionRow>, sqlx::Error> {
    sqlx::query_as::<_, RestrictionRow>(
        r#"SELECT id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                  reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                  s_send_reports, s_send_modmail, removed_at, removed_by, created_at
             FROM restrictions
            WHERE user_id = $1
              AND removed_at IS NULL
              AND (expires_at IS NULL OR expires_at > NOW())"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

// ---------------------------------------------------------------------------
// has_sanction — single EXISTS query
// ---------------------------------------------------------------------------

/// Returns `true` if the user has an active restriction with the given sanction flag
/// that applies to the given scope:
/// - A `global`-scope restriction always applies regardless of `clan_id`.
/// - A `clan`-scope restriction only applies when `clan_id` matches.
pub async fn has_sanction(
    pool: &PgPool,
    user_id: Uuid,
    sanction: &Sanction,
    clan_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let col = sanction.column();
    // We use a raw query string built at compile-check time — col is always a
    // known static string from the match above, never user input.
    let sql = format!(
        r#"SELECT EXISTS (
               SELECT 1 FROM restrictions
                WHERE user_id = $1
                  AND removed_at IS NULL
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND {col} = TRUE
                  AND (
                      scope = 'global'
                      OR (scope = 'clan' AND clan_id = $2)
                  )
           )"#
    );
    let result: bool = sqlx::query_scalar(&sql)
        .bind(user_id)
        .bind(clan_id)
        .fetch_one(pool)
        .await?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// ensure_not_sanctioned
// ---------------------------------------------------------------------------

/// Returns `Err(403, "you are <label>")` if the user has an active sanction.
/// Wire call sites into handlers that must respect restrictions (chat send,
/// template create, invite, report submit, modmail).
pub async fn ensure_not_sanctioned(
    pool: &PgPool,
    user_id: Uuid,
    sanction: Sanction,
    clan_id: Option<Uuid>,
) -> Result<(), (StatusCode, String)> {
    let label = sanction.label();
    let sanctioned = has_sanction(pool, user_id, &sanction, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if sanctioned {
        return Err((
            StatusCode::FORBIDDEN,
            format!("you are {label}"),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// check_sanctions — multiple sanctions in one query
// ---------------------------------------------------------------------------

/// Check several sanctions at once, returning the first active violation.
/// Each tuple is `(sanction, clan_context)` where `None` means global/non-clan
/// scope. A single DB query fetches all active restrictions; each sanction is
/// evaluated against the appropriate scope (global always applies, clan only
/// when the restriction's clan_id matches).
pub async fn check_sanctions(
    pool: &PgPool,
    user_id: Uuid,
    checks: &[(Sanction, Option<Uuid>)],
) -> Result<(), (StatusCode, String)> {
    let rows = active_restrictions(pool, user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for (sanction, clan_id) in checks {
        let applies = rows.iter().any(|r| {
            if !sanction.flag_on(r) {
                return false;
            }
            match r.scope.as_str() {
                "global" => true,
                "clan" => clan_id.map(|cid| r.clan_id == Some(cid)).unwrap_or(false),
                _ => false,
            }
        });
        if applies {
            return Err((StatusCode::FORBIDDEN, format!("you are {}", sanction.label())));
        }
    }
    Ok(())
}
