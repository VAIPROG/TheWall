//! POST /api/v3/users/resolve
//!
//! Batch-resolve user references (UUID, `@username`, or bare username) to UUIDs.
//! Lets clients accept human-friendly usernames in template access lists
//! (whitelist / blocklist / co-editors) and convert them to the UUIDs the ACL
//! stores. Authenticated to avoid anonymous user-enumeration.
use crate::http_error::ResultExt;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, routes::v3::utils::users::resolve_user_ref_opt};

/// Cap per request so a single call can't scan the users table unboundedly.
const MAX_REFS: usize = 200;

#[derive(Debug, Deserialize)]
pub struct ResolveRequest {
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    /// Input ref (as given) → resolved UUID.
    pub resolved: BTreeMap<String, Uuid>,
    /// Refs that matched no user.
    pub unresolved: Vec<String>,
}

pub async fn resolve_users(
    _auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<ResolveResult>, (StatusCode, String)> {
    let mut resolved = BTreeMap::new();
    let mut unresolved = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for raw in body.refs.iter().take(MAX_REFS) {
        let r = raw.trim();
        if r.is_empty() || !seen.insert(r.to_string()) {
            continue;
        }
        match resolve_user_ref_opt(&state.pool, r).await? {
            Some(uid) => {
                resolved.insert(r.to_string(), uid);
            }
            None => unresolved.push(r.to_string()),
        }
    }

    Ok(Json(ResolveResult { resolved, unresolved }))
}
