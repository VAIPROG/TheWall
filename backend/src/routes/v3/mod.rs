//! V3 routes.
//!
//! Lives at /api/v3/*. V3 introduces the split identity model:
//! `users` is the canonical Account; `site_identities` hold per-site
//! connections; `provider_links` hold OAuth connections.

pub mod auth;
pub mod chats;
pub mod templates;
pub mod users;
pub mod utils;
