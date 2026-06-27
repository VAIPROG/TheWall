use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, hash_token, issue_session_pair, verify_token},
    models::{
        AccountPublic, ProviderLink, Session, SiteIdentity, User, V3AuthResponse, V3AuthSiteRequest,
        V3RefreshRequest,
    },
};

// ---------------------------------------------------------------------------
// filianislost.com /user/me response shape (local copy; mirrors routes/auth.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SiteUser {
    id: i64,
    username: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn account_public(user: &User) -> AccountPublic {
    AccountPublic {
        id: user.id,
        username: user.username.clone(),
        display_name: None,
        role: user.global_role.clone(),
    }
}

fn v3_response(access_token: String, refresh_token: String, user: &User) -> V3AuthResponse {
    V3AuthResponse {
        access_token,
        refresh_token,
        expires_in: 86400,
        token_type: "Bearer".into(),
        user: account_public(user),
    }
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/site — attach-or-create
// ---------------------------------------------------------------------------

pub async fn site(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<V3AuthSiteRequest>,
) -> Result<Json<V3AuthResponse>, StatusCode> {
    // 1. Only filianislost is supported in this slice.
    if body.site != "filianislost" {
        return Err(StatusCode::NOT_IMPLEMENTED);
    }

    // 2. Verify site token by calling the upstream /user/me endpoint.
    let client = reqwest::Client::new();
    let site_resp = client
        .get(format!("{}/user/me", state.site_url))
        .header("Authorization", body.token.as_str())
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !site_resp.status().is_success() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let site_user: SiteUser = site_resp
        .json()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let external_id = site_user.id.to_string();
    let site_username = site_user.username.clone();

    // 3. Optional current account from Bearer JWT in this request's headers.
    let current: Option<Uuid> = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| verify_token(token, &state.jwt_secret).ok())
        .and_then(|claims| Uuid::parse_str(&claims.sub).ok());

    // 4. Look up existing site identity.
    let existing_account_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM site_identities WHERE source = 'filianislost' AND external_id = $1",
    )
    .bind(&external_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 5. Branch: resolve which account to use.
    let account_id: Uuid = match existing_account_id {
        Some(existing) => {
            // Conflict: identity is owned by a different authenticated account.
            if let Some(cur) = current {
                if cur != existing {
                    return Err(StatusCode::CONFLICT);
                }
            }
            // Update last_seen_at + site_username.
            sqlx::query(
                "UPDATE site_identities SET last_seen_at = now(), site_username = $1 \
                 WHERE source = 'filianislost' AND external_id = $2",
            )
            .bind(&site_username)
            .bind(&external_id)
            .execute(&state.pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

            existing
        }
        None => {
            match current {
                Some(cur) => {
                    // ATTACH: link this site identity to the already-authenticated account.
                    sqlx::query(
                        "INSERT INTO site_identities \
                         (id, account_id, source, external_id, site_username) \
                         VALUES (gen_random_uuid(), $1, 'filianislost', $2, $3) \
                         ON CONFLICT (source, external_id) DO NOTHING",
                    )
                    .bind(cur)
                    .bind(&external_id)
                    .bind(&site_username)
                    .execute(&state.pool)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

                    cur
                }
                None => {
                    // CREATE: upsert account then attach site identity.
                    let legacy_role = if site_user.username.to_lowercase() == "vai" {
                        "admin"
                    } else {
                        "member"
                    };

                    let new_user = sqlx::query_as::<_, User>(
                        r#"
                        INSERT INTO users (id, source, external_id, username, role, global_role, created_at, updated_at)
                        VALUES ($1, 'filianislost', $2, $3, $4,
                                CASE WHEN LOWER($3) = 'vai' THEN 'owner' ELSE 'member' END,
                                now(), now())
                        ON CONFLICT (source, external_id) DO UPDATE
                            SET username    = EXCLUDED.username,
                                role        = CASE WHEN LOWER(EXCLUDED.username) = 'vai' THEN 'admin' ELSE users.role END,
                                global_role = CASE WHEN LOWER(EXCLUDED.username) = 'vai' THEN 'owner' ELSE users.global_role END,
                                updated_at  = now()
                        RETURNING *
                        "#,
                    )
                    .bind(Uuid::new_v4())
                    .bind(&external_id)
                    .bind(&site_user.username)
                    .bind(legacy_role)
                    .fetch_one(&state.pool)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

                    sqlx::query(
                        "INSERT INTO site_identities \
                         (id, account_id, source, external_id, site_username) \
                         VALUES (gen_random_uuid(), $1, 'filianislost', $2, $3) \
                         ON CONFLICT (source, external_id) DO NOTHING",
                    )
                    .bind(new_user.id)
                    .bind(&external_id)
                    .bind(&site_username)
                    .execute(&state.pool)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

                    new_user.id
                }
            }
        }
    };

    // NOTE: best-effort clan sync is skipped in this slice.

    // 6. Issue session pair.
    let (access, refresh) = issue_session_pair(&state.pool, &state.jwt_secret, account_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 7. Load account row for the response.
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(account_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 8. Return V3AuthResponse.
    Ok(Json(v3_response(access, refresh, &user)))
}

// ---------------------------------------------------------------------------
// GET /api/v3/auth/session — current account + identities + providers
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub user: AccountPublic,
    pub site_identities: Vec<SiteIdentity>,
    pub providers: Vec<ProviderLink>,
}

pub async fn session(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<SessionInfo>, StatusCode> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let site_identities = sqlx::query_as::<_, SiteIdentity>(
        "SELECT * FROM site_identities WHERE account_id = $1 ORDER BY linked_at",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let providers = sqlx::query_as::<_, ProviderLink>(
        "SELECT * FROM provider_links WHERE account_id = $1 ORDER BY linked_at",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SessionInfo {
        user: account_public(&user),
        site_identities,
        providers,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/refresh
// ---------------------------------------------------------------------------

pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<V3RefreshRequest>,
) -> Result<Json<V3AuthResponse>, StatusCode> {
    let refresh_hash = hash_token(&body.refresh_token);
    let now = Utc::now();

    let session = sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE refresh_hash = $1 AND expires_at > $2 LIMIT 1",
    )
    .bind(&refresh_hash)
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Delete old session.
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(session.id)
        .execute(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Issue new session pair.
    let (access, new_refresh) = issue_session_pair(&state.pool, &state.jwt_secret, user.id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(v3_response(access, new_refresh, &user)))
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/logout
// ---------------------------------------------------------------------------
//
// NOTE (slice 1 simplification): deletes ALL sessions for the user — i.e.,
// logs out everywhere. A future slice can narrow this to delete only the
// session matching the Bearer token's hash.

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthUser,
    _headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}
