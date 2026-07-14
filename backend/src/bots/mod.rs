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

/// Spawn the bot framework runtime. Filled in Task 7; legacy bots still run.
pub fn spawn(_state: crate::AppState) {}
