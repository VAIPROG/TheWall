//! Shared HTTP-error helper.
//!
//! `.or_500()` maps an internal failure to a `500` WITHOUT leaking the
//! underlying error to the client. The full detail is logged server-side with a
//! random `trace_id`; the client only receives `internal error (ref: <id>)`, so
//! a user can quote the id when reporting and we can grep the log for it.
//!
//! IMPORTANT: this is deliberately NOT a blanket `impl<T, E: Display>` over all
//! `Result`. A broad blanket impl over every `Result` triggered an
//! incremental-compilation miscompile once (binary starts but every request
//! hangs — see deploy notes / v6.1.1). Instead the trait is implemented for the
//! concrete error types actually used behind `.or_500()`, via the macro below.
//! If a new call site uses a not-yet-listed error type, the build fails with
//! "method `or_500` not found" — add the type to `impl_or_500!`.

use axum::http::StatusCode;

pub trait ResultExt<T> {
    /// Log the error (with a `trace_id`) and return a masked `500` that never
    /// exposes the underlying error text to the client.
    fn or_500(self) -> Result<T, (StatusCode, String)>;
}

/// Log the full error server-side and return a client-safe `(500, message)`
/// carrying only a `trace_id` reference.
fn mask_500(err: impl std::fmt::Display) -> (StatusCode, String) {
    let trace_id = uuid::Uuid::new_v4();
    tracing::error!(%trace_id, error = %err, "internal error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("internal error (ref: {trace_id})"),
    )
}

macro_rules! impl_or_500 {
    ($($t:ty),+ $(,)?) => {
        $(
            impl<T> ResultExt<T> for Result<T, $t> {
                fn or_500(self) -> Result<T, (StatusCode, String)> {
                    self.map_err(mask_500)
                }
            }
        )+
    };
}

impl_or_500!(
    sqlx::Error,
    reqwest::Error,
    serde_json::Error,
    image::ImageError,
    std::io::Error,
    std::string::FromUtf8Error,
    std::num::ParseIntError,
    uuid::Error,
    base64::DecodeError,
);
