//! Shared HTTP-error helpers.
//!
//! Replaces the ~480 hand-written
//! `.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))` closures
//! scattered across the route handlers with a single reusable combinator.

use axum::http::StatusCode;

pub trait ResultExt<T> {
    /// Map any `Display` error into a `(500, message)` API error.
    fn or_500(self) -> Result<T, (StatusCode, String)>;
}

impl<T, E: std::fmt::Display> ResultExt<T> for Result<T, E> {
    fn or_500(self) -> Result<T, (StatusCode, String)> {
        self.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }
}
