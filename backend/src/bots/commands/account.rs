use crate::bots::core::command::{Command, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Action, ActionRow, Block, BotResponse, BtnStyle, Component};

pub struct Help;
#[async_trait::async_trait]
impl Command for Help {
    fn name(&self) -> &'static str { "help" }
    fn description(&self) -> &'static str { "List the commands you can run" }
    fn permission(&self) -> Permission { Permission::Public }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let reg = crate::bots::registry();
        let mut cmds: Vec<(&str, &str)> = reg
            .all()
            .filter(|c| crate::bots::core::permissions::gate(c.permission(), &ctx.principal))
            .map(|c| (c.name(), c.description()))
            .collect();
        cmds.sort_by(|a, b| a.0.cmp(b.0));
        BotResponse::heading("Commands")
            .push(Block::Fields(
                cmds.into_iter()
                    .map(|(n, d)| (n.to_string(), d.to_string()))
                    .collect(),
            ))
            .ephemeral()
    }
}

pub struct Me;
#[async_trait::async_trait]
impl Command for Me {
    fn name(&self) -> &'static str { "me" }
    fn description(&self) -> &'static str { "Your Wall profile" }
    fn permission(&self) -> Permission { Permission::Linked }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let Some(uid) = ctx.principal.user_id else {
            return BotResponse::text(
                "Link your Wall account first (extension → Settings → Linked accounts).",
            )
            .ephemeral();
        };
        match crate::bots::core::data::me_data(&ctx.state.pool, uid).await {
            Some(d) => {
                let clan = match (&d.clan_name, &d.clan_role) {
                    (Some(name), Some(role)) => format!("{name} ({role})"),
                    (Some(name), None) => name.clone(),
                    _ => "—".to_string(),
                };
                BotResponse::heading(format!("👤 {}", d.username)).push(Block::Fields(vec![
                    ("Global role".into(), d.global_role),
                    ("Clan".into(), clan),
                    ("Pixels placed".into(), d.pixels_placed.to_string()),
                    (
                        "Telegram linked".into(),
                        if d.telegram_linked { "✅" } else { "—" }.into(),
                    ),
                    (
                        "Discord linked".into(),
                        if d.discord_linked { "✅" } else { "—" }.into(),
                    ),
                ]))
            }
            None => BotResponse::text("Profile not found.").ephemeral(),
        }
    }
}

pub struct Link;
#[async_trait::async_trait]
impl Command for Link {
    fn name(&self) -> &'static str { "link" }
    fn description(&self) -> &'static str { "How to link your Wall account" }
    fn permission(&self) -> Permission { Permission::Public }
    async fn handle(&self, _ctx: &CommandCtx<'_>) -> BotResponse {
        BotResponse::text(
            "To link your Wall account, open The Wall extension → Settings → Linked accounts, \
             then connect your Telegram and/or Discord. Once linked, commands like `me` will \
             know who you are.",
        )
        .row(ActionRow(vec![Component::Button {
            label: "Open The Wall".into(),
            style: BtnStyle::Primary,
            action: Action::Url("https://the-wall.vai-rice.space".into()),
        }]))
    }
}
