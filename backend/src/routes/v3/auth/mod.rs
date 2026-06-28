mod site;
mod session;
mod tokens;
pub mod oauth;

pub use site::site;
pub use session::session;
pub use tokens::{refresh, logout};

// ---------------------------------------------------------------------------
// Shared helpers used by submodules
// ---------------------------------------------------------------------------

use crate::models::{AccountPublic, User, V3AuthResponse};

pub(crate) fn account_public(user: &User) -> AccountPublic {
    AccountPublic {
        id: user.id,
        username: user.username.clone(),
        display_name: None,
        role: user.global_role.clone(),
    }
}

pub(crate) fn v3_response(access_token: String, refresh_token: String, user: &User) -> V3AuthResponse {
    V3AuthResponse {
        access_token,
        refresh_token,
        expires_in: 86400,
        token_type: "Bearer".into(),
        user: account_public(user),
    }
}
