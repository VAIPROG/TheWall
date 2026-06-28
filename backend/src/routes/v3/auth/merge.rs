use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, create_merge_token, issue_session_pair, verify_merge_token},
    models::{MergeInitiateResponse, MergeRequest, MergeResult, User},
};

// ---------------------------------------------------------------------------
// POST /api/v3/auth/merge/initiate   (auth = account B)
//
// Mints a short-lived merge token that proves ownership of account B.
// The client passes this token to POST /api/v3/users/me/merge (auth = A) to
// complete the merge.
// ---------------------------------------------------------------------------

pub async fn merge_initiate(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<MergeInitiateResponse>, StatusCode> {
    let token = create_merge_token(&auth.user_id, &state.jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(MergeInitiateResponse {
        merge_token: token,
        expires_in: 600,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/users/me/merge   (auth = account A)   body: { merge_token }
//
// Folds account B (named by the merge token) into account A:
//  1. Validates the merge token → B.
//  2. Rejects A == B.
//  3. 409 if A and B share a site_identities source (same platform, two accounts).
//  4. Begins a transaction and re-parents every FK that points at B → A.
//  5. Rewrites stale author.id embedded in transferred template documents.
//  6. Writes an audit_log row.
//  7. Deletes account B.
//  8. Commits; issues fresh tokens for A.
// ---------------------------------------------------------------------------

pub async fn merge(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<MergeRequest>,
) -> Result<Json<MergeResult>, (StatusCode, Json<serde_json::Value>)> {
    let a: Uuid = auth.user_id;

    // 1. Verify the merge token to get B.
    let b: Uuid = verify_merge_token(&body.merge_token, &state.jwt_secret).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid or expired merge token"})),
        )
    })?;

    // 2. Self-merge guard.
    if a == b {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "cannot merge an account into itself"})),
        ));
    }

    // 3. Same-site precheck: fail if A and B share any source in site_identities.
    let conflicts: Vec<String> = sqlx::query_scalar(
        "SELECT source FROM site_identities WHERE account_id = $1
         INTERSECT
         SELECT source FROM site_identities WHERE account_id = $2",
    )
    .bind(a)
    .bind(b)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "db error during precheck"})),
        )
    })?;

    if !conflicts.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "MERGE_SITE_CONFLICT",
                "conflicting_sources": conflicts
            })),
        ));
    }

    // 4. Begin transaction and re-parent all FK columns.
    let mut tx = state.pool.begin().await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "failed to begin transaction"})),
        )
    })?;

    macro_rules! exec {
        ($q:expr) => {
            sqlx::query($q)
                .bind(a)
                .bind(b)
                .execute(&mut *tx)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": format!("db error: {}", e)})),
                    )
                })?
        };
    }

    // ---- sessions: drop B's sessions (do NOT move them) ----
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // ---- clan_messages.user_id ----
    exec!("UPDATE clan_messages SET user_id = $1 WHERE user_id = $2");

    // ---- templates.user_id ----
    exec!("UPDATE templates SET user_id = $1 WHERE user_id = $2");

    // ---- template_reports.user_id ----
    exec!("UPDATE template_reports SET user_id = $1 WHERE user_id = $2");

    // ---- notifications.user_id ----
    exec!("UPDATE notifications SET user_id = $1 WHERE user_id = $2");

    // ---- moderation_applications.user_id ----
    exec!("UPDATE moderation_applications SET user_id = $1 WHERE user_id = $2");

    // ---- direct_messages.from_user_id / to_user_id ----
    exec!("UPDATE direct_messages SET from_user_id = $1 WHERE from_user_id = $2");
    exec!("UPDATE direct_messages SET to_user_id   = $1 WHERE to_user_id   = $2");

    // ---- account_deletions.user_id ----
    exec!("UPDATE account_deletions SET user_id = $1 WHERE user_id = $2");

    // ---- error_reports.user_id (nullable / ON DELETE SET NULL) ----
    exec!("UPDATE error_reports SET user_id = $1 WHERE user_id = $2");

    // ---- audit_log.actor_id (nullable / ON DELETE SET NULL) ----
    exec!("UPDATE audit_log SET actor_id = $1 WHERE actor_id = $2");

    // ---- signal_notes.author_id (nullable / ON DELETE SET NULL) ----
    exec!("UPDATE signal_notes SET author_id = $1 WHERE author_id = $2");

    // ---- timelapse_renders.requested_by (nullable / ON DELETE SET NULL) ----
    exec!("UPDATE timelapse_renders SET requested_by = $1 WHERE requested_by = $2");

    // ---- anim_configs.user_id ----
    exec!("UPDATE anim_configs SET user_id = $1 WHERE user_id = $2");

    // ---- protected_regions.user_id ----
    exec!("UPDATE protected_regions SET user_id = $1 WHERE user_id = $2");

    // ---- paint_reminders.user_id ----
    exec!("UPDATE paint_reminders SET user_id = $1 WHERE user_id = $2");

    // ---- mailbox_items.sender_id (nullable / ON DELETE SET NULL) ----
    exec!("UPDATE mailbox_items SET sender_id = $1 WHERE sender_id = $2");

    // ---- mailbox_items.recipient_user_id ----
    exec!("UPDATE mailbox_items SET recipient_user_id = $1 WHERE recipient_user_id = $2");

    // ---- clan_modmail_threads.opener_user_id ----
    exec!("UPDATE clan_modmail_threads SET opener_user_id = $1 WHERE opener_user_id = $2");

    // ---- vai_links.user_id ----
    exec!("UPDATE vai_links SET user_id = $1 WHERE user_id = $2");

    // ---- provider_links.account_id — UNIQUE(provider, provider_uid): each
    //      (provider, provider_uid) pair already maps to exactly ONE account
    //      globally (enforced by the unique constraint at insert time), so if
    //      B has a provider link, A cannot have the same one. Simple UPDATE. ----
    exec!("UPDATE provider_links SET account_id = $1 WHERE account_id = $2");

    // ---- clan_memberships — UNIQUE(user_id, clan_id):
    //      delete B's rows for clans A is already in, then move the rest. ----
    sqlx::query(
        "DELETE FROM clan_memberships
         WHERE user_id = $1
           AND clan_id IN (SELECT clan_id FROM clan_memberships WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE clan_memberships SET user_id = $1 WHERE user_id = $2");

    // ---- pinned_templates — PK(user_id, slot) + UNIQUE(user_id, template_id):
    //      pins are cosmetic; drop B's rows entirely (A keeps its own pins). ----
    sqlx::query("DELETE FROM pinned_templates WHERE user_id = $1")
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // ---- user_achievements — PK(user_id, achievement_id):
    //      delete B's rows for achievements A already holds, move the rest. ----
    sqlx::query(
        "DELETE FROM user_achievements
         WHERE user_id = $1
           AND achievement_id IN (SELECT achievement_id FROM user_achievements WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE user_achievements SET user_id = $1 WHERE user_id = $2");

    // ---- mailbox_reads — PK(item_id, user_id):
    //      delete B's rows for items A has already read, move the rest. ----
    sqlx::query(
        "DELETE FROM mailbox_reads
         WHERE user_id = $1
           AND item_id IN (SELECT item_id FROM mailbox_reads WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE mailbox_reads SET user_id = $1 WHERE user_id = $2");

    // ---- notification_prefs — PK(user_id, kind):
    //      delete B's rows for kinds A already has, move the rest. ----
    sqlx::query(
        "DELETE FROM notification_prefs
         WHERE user_id = $1
           AND kind IN (SELECT kind FROM notification_prefs WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE notification_prefs SET user_id = $1 WHERE user_id = $2");

    // ---- avatars — PK = user_id:
    //      if A already has an avatar, drop B's row; otherwise move it. ----
    sqlx::query(
        "DELETE FROM avatars WHERE user_id = $1
         AND EXISTS (SELECT 1 FROM avatars WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE avatars SET user_id = $1 WHERE user_id = $2");

    // ---- user_stats — PK = user_id:
    //      if A already has stats, drop B's row (keep A's); otherwise move it.
    //      NOTE: this drops B's pixel/template counts rather than summing them.
    //      A future slice can SUM the columns here if desired. ----
    sqlx::query(
        "DELETE FROM user_stats WHERE user_id = $1
         AND EXISTS (SELECT 1 FROM user_stats WHERE user_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE user_stats SET user_id = $1 WHERE user_id = $2");

    // ---- account_recovery — PK = account_id:
    //      if A already has a recovery phrase, drop B's; otherwise move it. ----
    sqlx::query(
        "DELETE FROM account_recovery WHERE account_id = $1
         AND EXISTS (SELECT 1 FROM account_recovery WHERE account_id = $2)",
    )
    .bind(b)
    .bind(a)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    exec!("UPDATE account_recovery SET account_id = $1 WHERE account_id = $2");

    // ---- site_identities — UNIQUE(account_id, source) + UNIQUE(source, external_id):
    //      the precheck above guarantees A and B share no source, so a plain
    //      UPDATE is safe. ----
    exec!("UPDATE site_identities SET account_id = $1 WHERE account_id = $2");

    // 5. Rewrite stale author.id embedded in transferred template documents.
    //    Templates that belonged to B now belong to A, but their JSON document
    //    may still carry B's UUID as author.id — fix them up.
    sqlx::query(
        "UPDATE templates
         SET document = jsonb_set(document, '{author,id}', to_jsonb($1::text))
         WHERE user_id = $1
           AND document IS NOT NULL
           AND document #>> '{author,id}' = $2::text",
    )
    .bind(a)
    .bind(b)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // 6. Audit log entry.
    sqlx::query(
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, payload)
         VALUES (gen_random_uuid(), $1, 'account_merge', 'account', $2,
                 jsonb_build_object('merged_from', $2::text, 'merged_into', $1::text))",
    )
    .bind(a)
    .bind(b)
    .execute(&mut *tx)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // 7. Delete account B — all remaining cascades are intentional no-ops by now.
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{e}")}))))?;

    // Commit.
    tx.commit().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("commit failed: {e}")})),
        )
    })?;

    // 8. Issue fresh session for A and load account row.
    let (access, refresh_tok) = issue_session_pair(&state.pool, &state.jwt_secret, a)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("session issuance failed: {e}")})),
            )
        })?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(a)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("user reload failed: {e}")})),
            )
        })?;

    let auth_response = super::v3_response(access, refresh_tok, &user);

    Ok(Json(MergeResult {
        merged_account_id: a,
        auth: auth_response,
    }))
}

