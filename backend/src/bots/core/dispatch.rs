use std::collections::HashMap;
use crate::AppState;
use super::command::{Chat, ArgValue, CommandCtx, Platform};
use super::permissions::{gate, resolve_principal};
use super::registry::Registry;
use super::response::BotResponse;

pub struct Invocation {
    pub external_id: String,
    pub chat: Chat,
    pub command: String,
    pub sub: Option<String>,
    pub args: HashMap<String, ArgValue>,
}

pub async fn run(state: &AppState, reg: &Registry, platform: Platform, inv: Invocation) -> BotResponse {
    let Some(cmd) = reg.get(&inv.command) else {
        return BotResponse::text("Unknown command. Try /help.").ephemeral();
    };
    let principal = resolve_principal(state, platform, &inv.external_id).await;
    if !gate(cmd.permission(), &principal) {
        return BotResponse::text("You don't have permission for that.").ephemeral();
    }
    let ctx = CommandCtx { state, principal, chat: inv.chat, sub: inv.sub, args: inv.args };
    cmd.handle(&ctx).await
}
