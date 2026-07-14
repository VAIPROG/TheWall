//! NOTIFY command group — per-user opt-in for paint / region alerts. Each
//! subscription is keyed (user_id, platform, kind); the chat_id records the
//! latest chat the user subscribed from so alerts land where they last asked.
//! Both commands require a linked Wall account (Permission::Linked) and answer
//! with owner-scoped toggle buttons.
use crate::bots::core::callbacks::CallbackSpec;
use crate::bots::core::command::{ArgKind, Command, CommandArg, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Action, ActionRow, Block, BotResponse, BtnStyle, Component};

fn arg_str<'a>(ctx: &'a CommandCtx<'a>, key: &str) -> Option<&'a str> {
    ctx.arg(key).and_then(|a| a.as_str())
}

fn kind_arg() -> Vec<CommandArg> {
    vec![CommandArg {
        name: "kind".into(),
        kind: ArgKind::String,
        required: true,
        desc: "paint | region".into(),
    }]
}

// ── subscribe ────────────────────────────────────────────────────────────────
pub struct Subscribe;
#[async_trait::async_trait]
impl Command for Subscribe {
    fn name(&self) -> &'static str { "subscribe" }
    fn description(&self) -> &'static str { "Subscribe to paint or region alerts" }
    fn permission(&self) -> Permission { Permission::Linked }
    fn args(&self) -> Vec<CommandArg> { kind_arg() }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        let kind = arg_str(ctx, "kind").unwrap_or("").to_lowercase();
        if kind != "paint" && kind != "region" {
            return BotResponse::text("kind must be paint or region").ephemeral();
        }
        let res = sqlx::query(
            "INSERT INTO bot_subscriptions (user_id, platform, chat_id, kind) VALUES ($1,$2,$3,$4) \
             ON CONFLICT (user_id, platform, kind) DO UPDATE SET chat_id=EXCLUDED.chat_id",
        )
        .bind(uid)
        .bind(ctx.chat.platform.as_str())
        .bind(&ctx.chat.id)
        .bind(&kind)
        .execute(&ctx.state.pool)
        .await;
        if res.is_err() {
            return BotResponse::text("Failed to subscribe.").ephemeral();
        }
        let off_id = ctx
            .state
            .callback_store
            .put(CallbackSpec {
                command: "unsubscribe".into(),
                sub: None,
                args: vec![("kind".into(), kind.clone())],
                owner_external_id: ctx.principal.platform_id.clone(),
            })
            .await;
        BotResponse::heading("🔔 Subscribed")
            .push(Block::Text(format!("You'll get **{kind}** alerts here.")))
            .row(ActionRow(vec![Component::Button {
                label: "Unsubscribe".into(),
                style: BtnStyle::Danger,
                action: Action::Callback(off_id),
            }]))
            .ephemeral()
    }
}

// ── unsubscribe ──────────────────────────────────────────────────────────────
pub struct Unsubscribe;
#[async_trait::async_trait]
impl Command for Unsubscribe {
    fn name(&self) -> &'static str { "unsubscribe" }
    fn description(&self) -> &'static str { "Stop paint or region alerts" }
    fn permission(&self) -> Permission { Permission::Linked }
    fn args(&self) -> Vec<CommandArg> { kind_arg() }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text("Link your Wall account first.").ephemeral();
        };
        let kind = arg_str(ctx, "kind").unwrap_or("").to_lowercase();
        if kind != "paint" && kind != "region" {
            return BotResponse::text("kind must be paint or region").ephemeral();
        }
        let res = sqlx::query(
            "DELETE FROM bot_subscriptions WHERE user_id=$1 AND platform=$2 AND kind=$3",
        )
        .bind(uid)
        .bind(ctx.chat.platform.as_str())
        .bind(&kind)
        .execute(&ctx.state.pool)
        .await;
        if res.is_err() {
            return BotResponse::text("Failed to unsubscribe.").ephemeral();
        }
        let on_id = ctx
            .state
            .callback_store
            .put(CallbackSpec {
                command: "subscribe".into(),
                sub: None,
                args: vec![("kind".into(), kind.clone())],
                owner_external_id: ctx.principal.platform_id.clone(),
            })
            .await;
        BotResponse::heading("🔕 Unsubscribed")
            .push(Block::Text(format!("Stopped **{kind}** alerts.")))
            .row(ActionRow(vec![Component::Button {
                label: "Subscribe again".into(),
                style: BtnStyle::Success,
                action: Action::Callback(on_id),
            }]))
            .ephemeral()
    }
}
