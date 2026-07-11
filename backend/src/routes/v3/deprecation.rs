//! Deprecation middleware for legacy V1/V2 API routes.
//!
//! Applied to `/api/*` *before* the V3 router is mounted, so it only affects
//! legacy routes. It:
//!   1. Adds `Deprecation` and `Sunset` headers to every legacy response.
//!   2. Injects a `_deprecation` field into JSON response bodies when the body
//!      is small enough to buffer safely.
//!   3. If the `hard_deprecate_legacy_api` runtime flag is enabled, returns
//!      `410 Gone` instead of proxying the request.
//!   4. If the caller presents a valid V3 Bearer token and their account is
//!      globally banned, returns a structured 403 directing them to V3.

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use crate::http_error::ResultExt;

use crate::AppState;

const DEPRECATION_HEADER: &str = "Deprecation";
const SUNSET_HEADER: &str = "Sunset";
const MAX_JSON_BUFFER_BYTES: usize = 256 * 1024;

/// Inject deprecation headers and, for small JSON bodies, a `_deprecation`
/// warning field.  If hard deprecation is enabled, returns 410 instead.
pub async fn v1_v2_deprecation_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    // `/api/v3/*` routes are current, not legacy — even the few that are mounted
    // on the legacy router for convenience (e.g. `/api/v3/meta`). Never annotate
    // them with a deprecation notice or `_deprecation` body field, otherwise
    // strict V3 clients choke on the unexpected field.
    if request.uri().path().starts_with("/api/v3") {
        return Ok(next.run(request).await);
    }

    // Hard deprecation gate.
    let hard_deprecate = state.config.runtime.read().await.feature_flags
        .get("hard_deprecate_legacy_api")
        .copied()
        .unwrap_or(false);

    if hard_deprecate {
        let body = json!({
            "error": "legacy_api_deprecated",
            "message": "This API version is no longer available. Please migrate to /api/v3.",
            "documentationUrl": "/docs/api/v3",
            "deprecationDate": "2026-07-01",
        });
        return Ok((
            StatusCode::GONE,
            [(
                DEPRECATION_HEADER,
                HeaderValue::from_static("true"),
            )],
            axum::Json(body),
        )
            .into_response());
    }

    // Optional: if the caller is authenticated via V3 token and globally
    // banned, return a helpful 403 instead of letting the legacy handler run.
    if let Some(token) = extract_bearer(&request) {
        if let Ok(claims) = crate::auth::verify_token(token, &state.config.jwt_secret) {
            if let (Ok(session_id), Ok(user_id)) = (
                uuid::Uuid::parse_str(&claims.jti),
                uuid::Uuid::parse_str(&claims.sub),
            ) {
                let valid = crate::auth::validate_session(
                    &state.pool,
                    session_id,
                    &claims.token_hash,
                )
                .await
                .or_500()?;

                if valid {
                    let banned = crate::routes::v3::utils::sanctions::has_sanction(
                        &state.pool,
                        user_id,
                        &crate::routes::v3::utils::sanctions::Sanction::Ban,
                        None,
                    )
                    .await
                    .or_500()?;

                    if banned {
                        let body = json!({
                            "error": "account_restricted",
                            "message": "Your account is restricted. Please use /api/v3/users/me/restrictions to view details, /api/v3/users/me/appeal to submit an appeal, or contact platform administration.",
                            "appealUrl": "/api/v3/users/me/appeal",
                            "restrictionsUrl": "/api/v3/users/me/restrictions",
                        });
                        return Ok((
                            StatusCode::FORBIDDEN,
                            [
                                (DEPRECATION_HEADER, HeaderValue::from_static("true")),
                                (SUNSET_HEADER, HeaderValue::from_static("Sat, 01 Aug 2026 00:00:00 GMT")),
                            ],
                            axum::Json(body),
                        )
                            .into_response());
                    }
                }
            }
        }
    }

    let response = next.run(request).await;
    let status = response.status();

    // Inject deprecation headers.
    let (mut parts, mut body) = response.into_parts();
    parts.headers.insert(
        DEPRECATION_HEADER,
        HeaderValue::from_static("true"),
    );
    parts.headers.insert(
        SUNSET_HEADER,
        HeaderValue::from_static("Sat, 01 Aug 2026 00:00:00 GMT"),
    );

    // Buffer small JSON bodies to inject `_deprecation`.
    let content_type = parts
        .headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let is_json = content_type.as_deref() == Some("application/json")
        || content_type.as_deref().map(|s| s.starts_with("application/json;")).unwrap_or(false);

    if is_json {
        // NOTE: `to_bytes` consumes the body, so we must ALWAYS rebuild the
        // response from the buffered bytes. The previous version took the body
        // with `std::mem::take` and, when it exceeded MAX_JSON_BUFFER_BYTES,
        // fell through to `Response::from_parts(parts, body)` with an already
        // emptied `body` — returning a 200 with an empty payload. That silently
        // blanked large legacy responses (e.g. the full template list), which
        // looked like "all templates disappeared".
        match axum::body::to_bytes(std::mem::take(&mut body), 32 * 1024 * 1024).await {
            Ok(bytes) => {
                // Inject the deprecation notice only into small JSON *objects*.
                // Arrays (the template/signal lists) and large bodies pass
                // through untouched.
                if bytes.len() <= MAX_JSON_BUFFER_BYTES {
                    if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert(
                                "_deprecation".to_string(),
                                json!({
                                    "message": "This API version is deprecated. Please migrate to /api/v3.",
                                    "sunsetDate": "2026-08-01",
                                    "documentationUrl": "/docs/api/v3",
                                }),
                            );
                            let new_body = serde_json::to_string(&value)
                                .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string());
                            return Ok(Response::builder()
                                .status(status)
                                .header(axum::http::header::CONTENT_TYPE, "application/json")
                                .body(Body::from(new_body))
                                .unwrap());
                        }
                    }
                }
                // Large body, JSON array, or non-object: return the bytes verbatim.
                let mut rebuilt = Response::from_parts(parts, Body::from(bytes));
                *rebuilt.status_mut() = status;
                return Ok(rebuilt);
            }
            Err(_) => {
                // Body exceeded 32 MB — cannot buffer. Return an explicit error
                // rather than a misleading empty 200.
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "legacy response too large to proxy".to_string(),
                ));
            }
        }
    }

    Ok(Response::from_parts(parts, body))
}

fn extract_bearer(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

async fn buffer_body(body: Body, limit: usize) -> Result<Bytes, &'static str> {
    let bytes = axum::body::to_bytes(body, limit).await.map_err(|_| "body too large")?;
    if bytes.len() > limit {
        return Err("body too large");
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::extract_bearer;
    use axum::http::{Request, header};

    #[test]
    fn extracts_bearer_token() {
        let mut req = Request::builder().uri("/").body(axum::body::Body::empty()).unwrap();
        req.headers_mut().insert(header::AUTHORIZATION, "Bearer abc123".parse().unwrap());
        assert_eq!(extract_bearer(&req), Some("abc123"));
    }

    #[test]
    fn ignores_non_bearer_auth() {
        let mut req = Request::builder().uri("/").body(axum::body::Body::empty()).unwrap();
        req.headers_mut().insert(header::AUTHORIZATION, "Basic abc123".parse().unwrap());
        assert_eq!(extract_bearer(&req), None);
    }

    #[test]
    fn no_auth_header_returns_none() {
        let req = Request::builder().uri("/").body(axum::body::Body::empty()).unwrap();
        assert_eq!(extract_bearer(&req), None);
    }
}
