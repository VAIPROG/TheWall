use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{issue_session_pair, verify_token},
    models::{User, V3AuthResponse, V3AuthSiteRequest},
    sites::{self, Source},
};

// ---------------------------------------------------------------------------
// POST /api/v3/auth/site — site-aware attach-or-create
//
// The request MUST name its `site`; verification is routed per-source through
// sites::verify (filianislost is live; wplace is wired but not yet verifiable).
// `users` is the canonical Account; `site_identities` holds each platform link.
// ---------------------------------------------------------------------------

pub async fn site(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<V3AuthSiteRequest>,
) -> Result<Json<V3AuthResponse>, StatusCode> {
    // 1. Resolve the named site. Unknown → 400; recognised-but-not-verifiable
    //    (wplace today) → 501.
    let source = Source::parse(&body.site).ok_or(StatusCode::BAD_REQUEST)?;
    if matches!(source, Source::Wplace) {
        return Err(StatusCode::NOT_IMPLEMENTED);
    }
    let src = source.as_str();

    // 2. Verify the site token against THAT source (per-site upstream call).
    let verified = sites::verify(source, &body.token)
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let external_id = verified.external_id;
    let site_username = verified.username;

    // 3. Optional current account from a Bearer JWT in this request's headers.
    let current: Option<Uuid> = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| verify_token(token, &state.jwt_secret).ok())
        .and_then(|claims| Uuid::parse_str(&claims.sub).ok());

    // 4. Look up an existing site identity for (source, external_id).
    let existing_account_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM site_identities WHERE source = $1 AND external_id = $2",
    )
    .bind(src)
    .bind(&external_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 5. Resolve which account to use.
    let account_id: Uuid = match existing_account_id {
        Some(existing) => {
            // Conflict: identity is owned by a DIFFERENT authenticated account
            // (the merge flow handles unifying two accounts).
            if let Some(cur) = current {
                if cur != existing {
                    return Err(StatusCode::CONFLICT);
                }
            }
            sqlx::query(
                "UPDATE site_identities SET last_seen_at = now(), site_username = $1 \
                 WHERE source = $2 AND external_id = $3",
            )
            .bind(&site_username)
            .bind(src)
            .bind(&external_id)
            .execute(&state.pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            existing
        }
        None => match current {
            Some(cur) => {
                // ATTACH this site identity to the already-authenticated account.
                sqlx::query(
                    "INSERT INTO site_identities \
                     (id, account_id, source, external_id, site_username) \
                     VALUES (gen_random_uuid(), $1, $2, $3, $4) \
                     ON CONFLICT (source, external_id) DO NOTHING",
                )
                .bind(cur)
                .bind(src)
                .bind(&external_id)
                .bind(&site_username)
                .execute(&state.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                cur
            }
            None => {
                // CREATE: upsert the Account (users) for this site identity, then
                // attach the site_identity. The vai easter egg keeps the author
                // a global owner; comparison is case-insensitive.
                let legacy_role = if site_username.eq_ignore_ascii_case("vai") {
                    "admin"
                } else {
                    "member"
                };
                let new_user = sqlx::query_as::<_, User>(
                    r#"
                    INSERT INTO users (id, source, external_id, username, role, global_role, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5,
                            CASE WHEN LOWER($4) = 'vai' THEN 'owner' ELSE 'member' END,
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
                .bind(src)
                .bind(&external_id)
                .bind(&site_username)
                .bind(legacy_role)
                .fetch_one(&state.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

                sqlx::query(
                    "INSERT INTO site_identities \
                     (id, account_id, source, external_id, site_username) \
                     VALUES (gen_random_uuid(), $1, $2, $3, $4) \
                     ON CONFLICT (source, external_id) DO NOTHING",
                )
                .bind(new_user.id)
                .bind(src)
                .bind(&external_id)
                .bind(&site_username)
                .execute(&state.pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

                new_user.id
            }
        },
    };

    // NOTE: best-effort clan sync (verified.clan) is deferred to a later slice.

    // 6. Issue the session pair.
    let (access, refresh) = issue_session_pair(&state.pool, &state.jwt_secret, account_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // 7. Load the account row for the response.
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(account_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(super::v3_response(access, refresh, &user)))
}
