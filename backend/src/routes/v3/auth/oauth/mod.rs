//! V3 OAuth center — provider-generic start + callback handlers.
//!
//! Routes:
//!   GET  /api/v3/auth/oauth/{provider}/start
//!   POST /api/v3/auth/oauth/{provider}/callback
//!
//! Supported providers: telegram, discord, github.
//! Both `login` and `link` intents are handled here.
use crate::http_error::ResultExt;

mod providers;

pub use providers::{Provider, pkce_s256, random_state};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{issue_session_pair, verify_token},
    models::{OAuthCallbackBody, OAuthStartQuery, OAuthStartResponse, User},
};

// ---------------------------------------------------------------------------
// GET /api/v3/auth/oauth/{provider}/start
// ---------------------------------------------------------------------------

pub async fn start(
    State(state): State<AppState>,
    Path(provider_str): Path<String>,
    headers: HeaderMap,
    Query(q): Query<OAuthStartQuery>,
) -> Result<Json<OAuthStartResponse>, (StatusCode, String)> {
    // 1. Resolve provider.
    let provider = Provider::parse(&provider_str)
        .ok_or((StatusCode::BAD_REQUEST, format!("unknown provider: {provider_str}")))?;

    // 2. Resolve client_id for this provider — 503 if unconfigured.
    let client_id = provider_client_id(&state, provider)?;

    // 3. Validate intent.
    let intent = q.intent.as_str();
    if intent != "login" && intent != "link" && intent != "clan-guilds" {
        return Err((
            StatusCode::BAD_REQUEST,
            "intent must be 'login', 'link', or 'clan-guilds'".to_string(),
        ));
    }
    // clan-guilds is a Discord-only flow (owned-guild enumeration).
    if intent == "clan-guilds" && provider != Provider::Discord {
        return Err((
            StatusCode::BAD_REQUEST,
            "intent=clan-guilds is only supported for provider=discord".to_string(),
        ));
    }

    // 4. For "link"/"clan-guilds", require a valid Bearer JWT — extract account_id.
    let account_id: Option<Uuid> = if intent == "link" || intent == "clan-guilds" {
        let uid = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|tok| verify_token(tok, &state.config.jwt_secret).ok())
            .and_then(|claims| Uuid::parse_str(&claims.sub).ok())
            .ok_or((
                StatusCode::UNAUTHORIZED,
                "this intent requires an authenticated session (Bearer token)".to_string(),
            ))?;
        Some(uid)
    } else {
        None
    };

    // 5. Resolve redirect URI.
    let redirect_uri = q
        .redirect_uri
        .unwrap_or_else(|| state.config.oauth.discord_redirect_uri.clone());

    // 6. Generate PKCE verifier + challenge, and a random state token.
    let state_token = random_state();
    let code_verifier = random_state();
    let code_challenge = pkce_s256(&code_verifier);

    // 7. INSERT into oauth_states.
    sqlx::query(
        r#"INSERT INTO oauth_states
               (state, user_id, provider, purpose, code_verifier, redirect_uri)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
    )
    .bind(&state_token)
    .bind(account_id)
    .bind(provider.as_str())
    .bind(intent)
    .bind(&code_verifier)
    .bind(&redirect_uri)
    .execute(&state.pool)
    .await
    .or_500()?;

    // 8. Build the authorization URL.
    let authorize_url = providers::authorize_url(
        provider,
        &client_id,
        &redirect_uri,
        &state_token,
        &code_challenge,
        intent,
    );

    Ok(Json(OAuthStartResponse {
        authorize_url,
        state: state_token,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/oauth/{provider}/callback
// ---------------------------------------------------------------------------

pub async fn callback(
    State(state): State<AppState>,
    Path(provider_str): Path<String>,
    Json(body): Json<OAuthCallbackBody>,
) -> Result<Response, (StatusCode, String)> {
    // 1. Resolve provider.
    let provider = Provider::parse(&provider_str)
        .ok_or((StatusCode::BAD_REQUEST, format!("unknown provider: {provider_str}")))?;

    // 2. Consume the state row (single-use, checks expiry + provider match).
    let row: Option<(Option<Uuid>, String, Option<String>, Option<String>)> = sqlx::query_as(
        r#"DELETE FROM oauth_states
            WHERE state = $1
              AND provider = $2
              AND expires_at > NOW()
           RETURNING user_id, purpose, code_verifier, redirect_uri"#,
    )
    .bind(&body.state)
    .bind(provider.as_str())
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let (stored_user_id, purpose, code_verifier_opt, redirect_uri_opt) =
        row.ok_or((StatusCode::BAD_REQUEST, "state expired or unknown".to_string()))?;

    let code_verifier = code_verifier_opt.ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "no pkce verifier in state row".to_string(),
    ))?;
    let redirect_uri = redirect_uri_opt
        .unwrap_or_else(|| state.config.oauth.discord_redirect_uri.clone());

    // 2b. clan-guilds flow: exchange the code for a raw Discord token, fetch the
    // caller's owned guilds, cache them, and discard the token. No identity link.
    if purpose == "clan-guilds" {
        if provider != Provider::Discord {
            return Err((
                StatusCode::BAD_REQUEST,
                "clan-guilds flow is only supported for provider=discord".to_string(),
            ));
        }
        let uid = stored_user_id.ok_or((
            StatusCode::BAD_REQUEST,
            "clan-guilds flow requires a logged-in user".to_string(),
        ))?;
        let access_token =
            providers::discord_code_to_token(&state, &body.code, &code_verifier, &redirect_uri)
                .await?;
        crate::routes::v3::clans::discord::ingest_owned_guilds(&state, uid, &access_token).await?;
        return Ok(
            Json(serde_json::json!({ "ok": true, "purpose": "clan-guilds" })).into_response(),
        );
    }

    // 3. Exchange code for provider identity.
    let identity = providers::code_to_identity(
        &state,
        provider,
        &body.code,
        &code_verifier,
        &redirect_uri,
    )
    .await?;

    // 4. Execute intent.
    let account_id = match purpose.as_str() {
        "link" => {
            // account_id must be present in the state row.
            let acct = stored_user_id.ok_or((
                StatusCode::BAD_REQUEST,
                "link intent requires user_id in state row".to_string(),
            ))?;

            // Guard: if this (provider, provider_uid) is already bound to a
            // DIFFERENT account, reject with 409 — don't steal the link.
            let existing_owner: Option<Uuid> = sqlx::query_scalar(
                "SELECT account_id FROM provider_links WHERE provider = $1 AND provider_uid = $2",
            )
            .bind(identity.provider)
            .bind(&identity.uid)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;

            if let Some(owner) = existing_owner {
                if owner != acct {
                    return Err((
                        StatusCode::CONFLICT,
                        format!(
                            "this {} account is already linked to a different Wall-Dev account",
                            identity.provider
                        ),
                    ));
                }
            }

            // UPSERT provider_links.
            sqlx::query(
                r#"INSERT INTO provider_links
                       (id, account_id, provider, provider_uid, username, is_verified)
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE)
                   ON CONFLICT (provider, provider_uid)
                   DO UPDATE SET
                       account_id  = EXCLUDED.account_id,
                       username    = EXCLUDED.username,
                       is_verified = TRUE"#,
            )
            .bind(acct)
            .bind(identity.provider)
            .bind(&identity.uid)
            .bind(identity.username.as_deref())
            .execute(&state.pool)
            .await
            .or_500()?;

            // Mirror to legacy users columns for v2 compatibility.
            // GitHub has no legacy column — skip.
            match identity.provider {
                "discord" => {
                    sqlx::query(
                        r#"UPDATE users
                              SET discord_id               = $1,
                                  discord_username         = $2,
                                  discord_linked_via_oauth = TRUE,
                                  updated_at               = NOW()
                            WHERE id = $3"#,
                    )
                    .bind(&identity.uid)
                    .bind(identity.username.as_deref())
                    .bind(acct)
                    .execute(&state.pool)
                    .await
                    .or_500()?;
                }
                "telegram" => {
                    sqlx::query(
                        r#"UPDATE users
                              SET telegram_user_id  = $1,
                                  telegram_username = $2,
                                  telegram_auth_date = NOW(),
                                  updated_at         = NOW()
                            WHERE id = $3"#,
                    )
                    .bind(&identity.uid)
                    .bind(identity.username.as_deref())
                    .bind(acct)
                    .execute(&state.pool)
                    .await
                    .or_500()?;
                }
                _ => {} // github: no legacy column
            }

            acct
        }

        "login" => {
            // Find account via provider_links.
            let found: Option<Uuid> = sqlx::query_scalar(
                "SELECT account_id FROM provider_links WHERE provider = $1 AND provider_uid = $2",
            )
            .bind(identity.provider)
            .bind(&identity.uid)
            .fetch_optional(&state.pool)
            .await
            .or_500()?;

            found.ok_or((
                StatusCode::NOT_FOUND,
                format!(
                    "no account linked to this {} — link it first",
                    identity.provider
                ),
            ))?
        }

        other => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("unknown purpose in state row: {other}"),
            ));
        }
    };

    // 5. Issue session pair.
    let (access, refresh, _session_id) = issue_session_pair(&state.pool, &state.config.jwt_secret, account_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // 6. Load account row.
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(account_id)
        .fetch_one(&state.pool)
        .await
        .or_500()?;

    Ok(Json(crate::routes::v3::auth::v3_response(access, refresh, &user)).into_response())
}

// ---------------------------------------------------------------------------
// Helper: resolve the OAuth client_id for a provider from AppState.oauth
// ---------------------------------------------------------------------------

fn provider_client_id(
    state: &AppState,
    provider: Provider,
) -> Result<String, (StatusCode, String)> {
    match provider {
        Provider::Telegram => state.config.oauth.telegram_client_id.clone().ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "TELEGRAM_CLIENT_ID not configured".to_string(),
        )),
        Provider::Discord => state.config.oauth.discord_client_id.clone().ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "DISCORD_CLIENT_ID not configured".to_string(),
        )),
        Provider::GitHub => state.config.oauth.github_client_id.clone().ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "GITHUB_CLIENT_ID not configured".to_string(),
        )),
    }
}
