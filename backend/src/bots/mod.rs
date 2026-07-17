pub mod core;
pub mod commands;
pub mod render;
pub mod telegram;
pub mod discord;
pub mod outbound;

use std::sync::{Arc, OnceLock};
use crate::bots::core::registry::Registry;

/// Process-wide command registry, built once on first use. Shared by every
/// adapter (Discord webhook handler can't take extra args; the gateway and
/// Telegram loop share the same instance so slash schema and dispatch agree).
pub fn registry() -> Arc<Registry> {
    static REG: OnceLock<Arc<Registry>> = OnceLock::new();
    REG.get_or_init(|| Arc::new(Registry::build())).clone()
}

/// Start every enabled bot adapter. Builds the shared registry once; the
/// Telegram long-poll loop, Discord slash registration, and Discord gateway
/// presence all share it.
pub fn spawn(state: crate::AppState) {
    let reg = registry(); // Arc<Registry>, built once (OnceLock)
    crate::bots::telegram::spawn(state.clone(), reg);
    crate::bots::discord::register_commands(state.config.oauth.clone());
    crate::bots::discord::gateway_spawn(state.clone());
}
