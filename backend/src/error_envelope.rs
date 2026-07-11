//! Structured error envelope (v6.1.3, Part B).
//!
//! Handlers across the codebase return `Result<T, (StatusCode, String)>`; axum
//! renders the `String` as a `text/plain` body. This outermost middleware
//! rewrites those plain-text error responses into a stable JSON shape:
//!
//! ```json
//! { "error": { "code": "not_found", "message": "template not found",
//!              "traceId": "b1f0…" } }
//! ```
//!
//! Design notes:
//!   * Only `text/plain` 4xx/5xx responses are touched. Responses that already
//!     carry a JSON body (e.g. the legacy deprecation 410/403 notices) pass
//!     through unchanged, so we never double-wrap.
//!   * 2xx/3xx are never touched.
//!   * `code` is a machine-readable category clients switch on — keep the
//!     strings stable.
//!   * A masked 500 from [`crate::http_error`] already embeds a trace id as
//!     `internal error (ref: <uuid>)`; we reuse it so the server log line and
//!     the client response share one id. Any other error gets a fresh id, also
//!     surfaced in the `X-Trace-Id` header for support tickets.
//!   * 5xx bodies are never echoed verbatim (they may carry internal detail);
//!     the client always sees a generic `internal error` plus the trace id.

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// Cap on how much of an error body we buffer before rewriting. Error strings
/// are tiny; anything larger is not one of ours — pass it straight through.
const MAX_ERROR_BODY: usize = 64 * 1024;

/// Stable, machine-readable code for a status. Clients switch on these, so do
/// not rename existing entries.
fn error_code(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => "bad_request",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::CONFLICT => "conflict",
        StatusCode::GONE => "gone",
        StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
        StatusCode::UNPROCESSABLE_ENTITY => "unprocessable",
        StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        StatusCode::NOT_IMPLEMENTED => "not_implemented",
        StatusCode::SERVICE_UNAVAILABLE => "unavailable",
        StatusCode::INTERNAL_SERVER_ERROR => "internal",
        s if s.is_server_error() => "server_error",
        s if s.is_client_error() => "client_error",
        _ => "error",
    }
}

/// Derive `(client_message, trace_id)` from a raw error body.
///
/// If the body is a masked 500 (`… (ref: <uuid>)`), the embedded id is reused
/// and the ref suffix stripped from the message. Otherwise a fresh id is
/// minted; for 5xx the raw text is suppressed (`internal error`) so internal
/// detail never leaks, while 4xx keep their human-readable message.
fn message_and_trace(text: &str, status: StatusCode) -> (String, String) {
    if let Some(idx) = text.find("(ref: ") {
        let rest = &text[idx + "(ref: ".len()..];
        if let Some(end) = rest.find(')') {
            let id = rest[..end].to_string();
            let msg = text[..idx].trim();
            let msg = if msg.is_empty() { "internal error" } else { msg };
            return (msg.to_string(), id);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    if status.is_server_error() {
        // A 5xx that did not go through `or_500` (e.g. a hand-written
        // `(500, String)`). Log it here so the detail isn't lost, but never
        // return it to the client.
        tracing::error!(trace_id = %id, error = %text, "unmasked server error");
        ("internal error".to_string(), id)
    } else {
        (text.to_string(), id)
    }
}

/// Outermost middleware: convert plain-text error responses to the JSON
/// envelope. Applied once to the merged app router.
pub async fn error_envelope_middleware(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();

    if !(status.is_client_error() || status.is_server_error()) {
        return response;
    }

    // Only rewrite our own plain-text error bodies; leave existing JSON alone.
    let is_text_plain = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.starts_with("text/plain"))
        .unwrap_or(false);
    if !is_text_plain {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_ERROR_BODY).await {
        Ok(b) => b,
        // Oversized/broken error body — return a minimal masked error rather
        // than panicking or leaking.
        Err(_) => {
            let id = uuid::Uuid::new_v4().to_string();
            return (
                status,
                axum::Json(json!({
                    "error": { "code": error_code(status), "message": "internal error", "traceId": id }
                })),
            )
                .into_response();
        }
    };

    let text = String::from_utf8_lossy(&bytes);
    let (message, trace_id) = message_and_trace(&text, status);

    let envelope = json!({
        "error": {
            "code": error_code(status),
            "message": message,
            "traceId": trace_id,
        }
    });
    let new_body = serde_json::to_vec(&envelope)
        .unwrap_or_else(|_| br#"{"error":{"code":"internal","message":"internal error"}}"#.to_vec());

    // Preserve any headers already set (Deprecation/Sunset from the legacy
    // middleware, etc.); just swap the body representation and add the trace id.
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(hv) = HeaderValue::from_str(&trace_id) {
        parts.headers.insert("x-trace-id", hv);
    }

    Response::from_parts(parts, Body::from(new_body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_maps_common_statuses() {
        assert_eq!(error_code(StatusCode::NOT_FOUND), "not_found");
        assert_eq!(error_code(StatusCode::FORBIDDEN), "forbidden");
        assert_eq!(error_code(StatusCode::INTERNAL_SERVER_ERROR), "internal");
        assert_eq!(error_code(StatusCode::IM_A_TEAPOT), "client_error");
    }

    #[test]
    fn reuses_masked_500_trace_id() {
        let (msg, id) = message_and_trace(
            "internal error (ref: 123e4567-e89b-12d3-a456-426614174000)",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
        assert_eq!(msg, "internal error");
        assert_eq!(id, "123e4567-e89b-12d3-a456-426614174000");
    }

    #[test]
    fn client_error_keeps_message_gets_fresh_id() {
        let (msg, id) = message_and_trace("template not found", StatusCode::NOT_FOUND);
        assert_eq!(msg, "template not found");
        assert!(!id.is_empty());
    }

    #[test]
    fn server_error_without_ref_is_suppressed() {
        let (msg, _id) =
            message_and_trace("connection refused to db", StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(msg, "internal error");
    }
}
