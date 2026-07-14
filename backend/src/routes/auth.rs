use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, create_token, generate_refresh_token, hash_token},
    models::{AuthResponse, AuthSiteRequest, RefreshRequest, UserPublic},
};

// ---------------------------------------------------------------------------
// filianislost.com /user/me response shape
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SiteClan {
    // Only fields we care about; extras are ignored by serde.
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    clan_id: Option<serde_json::Value>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    discord_id: Option<String>,
    #[serde(default)]
    icon: Option<String>,
}

async fn sync_clan_from_site(
    pool: &sqlx::PgPool,
    user_id: &uuid::Uuid,
    clan: &SiteClan,
) -> Result<(), sqlx::Error> {
    let ext = clan
        .clan_id
        .as_ref()
        .or(clan.id.as_ref())
        .and_then(|v| match v {
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        });
    let (Some(ext), Some(name)) = (ext, clan.name.clone()) else {
        return Ok(());
    };

    // Record/refresh the site-clan suggestion so the client can create a clan
    // from it on demand. We NO LONGER auto-create the clan here.
    sqlx::query(
        r#"INSERT INTO clan_suggestions
               (user_id, source, external_id, name, display_name, discord_id, icon, updated_at)
           VALUES ($1, 'filianislost', $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET source = 'filianislost', external_id = EXCLUDED.external_id,
                 name = EXCLUDED.name, display_name = EXCLUDED.display_name,
                 discord_id = EXCLUDED.discord_id, icon = EXCLUDED.icon,
                 updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&ext)
    .bind(&name)
    .bind(&clan.display_name)
    .bind(&clan.discord_id)
    .bind(&clan.icon)
    .execute(pool)
    .await?;

    // Attach membership ONLY if the clan already exists (legacy clans); never
    // create a new clan from a login.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM clans WHERE source = 'filianislost' AND external_id = $1",
    )
    .bind(&ext)
    .fetch_optional(pool)
    .await?;

    let Some(clan_uuid) = existing else {
        return Ok(());
    };

    let our_role = match clan.role.as_deref() {
        Some("owner") | Some("admin") => "admin",
        Some("moderator") | Some("mod") => "moderator",
        _ => "member",
    };
    sqlx::query(
        r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active)
           VALUES (gen_random_uuid(), $1, $2, $3, TRUE)
           ON CONFLICT (user_id, clan_id) DO UPDATE
             SET clan_role = EXCLUDED.clan_role, active = TRUE"#,
    )
    .bind(user_id)
    .bind(clan_uuid)
    .bind(our_role)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct SiteUser {
    id: i64,
    username: String,
    discord_id: Option<String>,
    #[serde(default)]
    discord_username: Option<String>,
    #[serde(default)]
    clan: Option<SiteClan>,
}

// ---------------------------------------------------------------------------
// POST /site
// ---------------------------------------------------------------------------

pub async fn site(
    State(state): State<AppState>,
    Json(body): Json<AuthSiteRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    // 1. Verify token with filianislost.com
    let client = reqwest::Client::new();
    let site_resp = client
        .get(format!("{}/user/me", state.config.site_url))
        .header("Authorization", body.site_token.as_str())
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

    // 2. Upsert user in DB. Legacy role is always 'member' here; promotion to
    // owner/admin is done via WALL_OWNER_SEED at first boot or manually later.
    let user = sqlx::query_as::<_, crate::models::User>(
        r#"
        INSERT INTO users (id, source, external_id, username, discord_id, discord_username, role, global_role, created_at, updated_at)
        VALUES ($1, 'filianislost', $2, $3, $4, $5, 'member', 'member', now(), now())
        ON CONFLICT (source, external_id) DO UPDATE
            SET username         = EXCLUDED.username,
                discord_id       = EXCLUDED.discord_id,
                discord_username = COALESCE(EXCLUDED.discord_username, users.discord_username),
                updated_at       = now()
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(&external_id)
    .bind(&site_user.username)
    .bind(site_user.discord_id)
    .bind(site_user.discord_username)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 3. Issue token pair
    let session_id = Uuid::new_v4();
    let (token, token_hash) = create_token(&user.id, &session_id, &state.config.jwt_secret, 24)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let refresh_token = generate_refresh_token();
    let refresh_hash = hash_token(&refresh_token);

    let now = Utc::now();
    let refresh_expires = now + chrono::Duration::days(7);

    // 4. Store session
    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, now())
        "#,
    )
    .bind(session_id)
    .bind(user.id)
    .bind(&token_hash)
    .bind(&refresh_hash)
    .bind(refresh_expires)
    .execute(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let clan_role = site_user.clan.as_ref().and_then(|c| c.role.clone());

    // Sync clan + clan_membership from the site payload so the v2 endpoints
    // immediately see this user as a member of the right clan. Failure here
    // is non-fatal — we don't want to block login if the clan table is wedged.
    if let Some(ref clan) = site_user.clan {
        let _ = sync_clan_from_site(&state.pool, &user.id, clan).await;
    }

    let has_custom_avatar: bool =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM avatars WHERE user_id = $1)")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);

    Ok(Json(AuthResponse {
        token,
        refresh_token,
        user: UserPublic {
            id: user.id,
            username: user.username,
            discord_id: user.discord_id,
            discord_username: user.discord_username,
            role: user.role,
            clan_role,
            has_custom_avatar,
        },
    }))
}

// ---------------------------------------------------------------------------
// POST /refresh
// ---------------------------------------------------------------------------

pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let refresh_hash = hash_token(&body.refresh_token);
    let now = Utc::now();

    // Look up the session by refresh_hash
    let session = sqlx::query_as::<_, crate::models::Session>(
        r#"
        SELECT * FROM sessions
        WHERE refresh_hash = $1
          AND expires_at > $2
        LIMIT 1
        "#,
    )
    .bind(&refresh_hash)
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    // Fetch the user
    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Delete old session
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(session.id)
        .execute(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Issue new token pair
    let new_session_id = Uuid::new_v4();
    let (token, token_hash) = create_token(&user.id, &new_session_id, &state.config.jwt_secret, 24)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let new_refresh = generate_refresh_token();
    let new_refresh_hash = hash_token(&new_refresh);
    let refresh_expires = now + chrono::Duration::days(7);

    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, now())
        "#,
    )
    .bind(new_session_id)
    .bind(user.id)
    .bind(&token_hash)
    .bind(&new_refresh_hash)
    .bind(refresh_expires)
    .execute(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(AuthResponse {
        token,
        refresh_token: new_refresh,
        user: UserPublic {
            id: user.id,
            username: user.username.clone(),
            discord_id: user.discord_id.clone(),
            discord_username: user.discord_username.clone(),
            role: user.role.clone(),
            clan_role: Some(user.role.clone()),
            has_custom_avatar: sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM avatars WHERE user_id = $1)",
            )
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false),
        },
    }))
}

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

pub async fn me(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<UserPublic>, StatusCode> {
    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let has_custom_avatar: bool =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM avatars WHERE user_id = $1)")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);

    Ok(Json(UserPublic {
        id: user.id,
        username: user.username.clone(),
        discord_id: user.discord_id.clone(),
        discord_username: user.discord_username.clone(),
        role: user.role.clone(),
        clan_role: Some(user.role),
        has_custom_avatar,
    }))
}
