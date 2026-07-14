use std::collections::HashMap;
use crate::AppState;
use super::permissions::{Permission, Principal};
use super::response::BotResponse;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform { Discord, Telegram }
impl Platform {
    pub fn as_str(self) -> &'static str { match self { Platform::Discord => "discord", Platform::Telegram => "telegram" } }
}

#[derive(Debug, Clone)]
pub struct Chat {
    pub id: String,
    pub is_group: bool,
    pub platform: Platform,
    /// guild_id: Discord server id when in a guild (None on Telegram / DMs). chat.id is the Telegram chat id or the Discord channel id.
    pub guild_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ArgKind { String, Int, Bool, Sub(Vec<CommandArg>) }
#[derive(Debug, Clone)]
pub struct CommandArg { pub name: String, pub kind: ArgKind, pub required: bool, pub desc: String }

#[derive(Debug, Clone)]
pub enum ArgValue { Str(String), Int(i64), Bool(bool), None }
impl ArgValue {
    pub fn as_str(&self) -> Option<&str> { if let ArgValue::Str(s) = self { Some(s) } else { None } }
    pub fn as_int(&self) -> Option<i64> { if let ArgValue::Int(i) = self { Some(*i) } else { None } }
}

pub struct CommandCtx<'a> {
    pub state: &'a AppState,
    pub principal: Principal,
    pub chat: Chat,
    pub sub: Option<String>,          // chosen subcommand, if any
    pub args: HashMap<String, ArgValue>,
}
impl<'a> CommandCtx<'a> {
    pub fn arg(&self, k: &str) -> Option<&ArgValue> { self.args.get(k) }
}

#[async_trait::async_trait]
pub trait Command: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn args(&self) -> Vec<CommandArg> { vec![] }
    fn permission(&self) -> Permission { Permission::Public }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse;
}
