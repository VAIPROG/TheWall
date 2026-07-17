use crate::bots::core::command::{ArgKind, Command, CommandArg, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{Block, BotResponse};

pub struct Wall;
#[async_trait::async_trait]
impl Command for Wall {
    fn name(&self) -> &'static str { "wall" }
    fn description(&self) -> &'static str { "Wall status and paint progress" }
    fn permission(&self) -> Permission { Permission::Public }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let s = crate::bots::core::data::status_data(&ctx.state.pool).await;
        BotResponse::heading("🧱 The Wall")
            .push(Block::Fields(vec![
                ("Users".into(), s.users.to_string()),
                ("Templates".into(), s.templates.to_string()),
            ]))
    }
}

pub struct Snapshot;
#[async_trait::async_trait]
impl Command for Snapshot {
    fn name(&self) -> &'static str { "snapshot" }
    fn description(&self) -> &'static str { "Latest wall snapshot" }
    fn permission(&self) -> Permission { Permission::Public }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let links = crate::bots::core::data::latest_snapshot(&ctx.state.pool).await;
        if links.is_empty() {
            return BotResponse::text("No snapshot yet.").ephemeral();
        }
        let mut resp = BotResponse::heading("📸 Latest snapshot");
        let mut any = false;
        for l in links {
            if let Some(url) = l.url {
                any = true;
                resp = resp.push(Block::Image {
                    url,
                    caption: Some(l.size),
                    spoiler: false,
                });
            }
        }
        if !any {
            resp = resp.push(Block::Text("Snapshot links unavailable.".into()));
        }
        resp
    }
}

pub struct Region;
#[async_trait::async_trait]
impl Command for Region {
    fn name(&self) -> &'static str { "region" }
    fn description(&self) -> &'static str { "Status of a protected region" }
    fn permission(&self) -> Permission { Permission::Public }
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg {
            name: "name".into(),
            kind: ArgKind::String,
            required: true,
            desc: "Region name".into(),
        }]
    }
    async fn handle(&self, ctx: &CommandCtx<'_>) -> BotResponse {
        let q = ctx.arg("name").and_then(|a| a.as_str()).unwrap_or("");
        let regions = crate::bots::core::data::regions_overview(&ctx.state.pool).await;
        match regions.iter().find(|r| r.name.eq_ignore_ascii_case(q)) {
            Some(r) => BotResponse::heading(format!("🛡 {}", r.name)).push(Block::Fields(vec![
                (
                    "State".into(),
                    crate::bots::core::data::region_state_label(r).to_string(),
                ),
                ("Position".into(), format!("{},{}", r.x, r.y)),
                ("Size".into(), format!("{}×{}", r.w, r.h)),
                ("Broken".into(), format!("{:.1}%", r.broken_pct)),
                ("Enabled".into(), if r.enabled { "yes" } else { "no" }.into()),
            ])),
            None => {
                let mut msg = format!("No region named `{q}`.");
                let names: Vec<&str> = regions.iter().take(3).map(|r| r.name.as_str()).collect();
                if !names.is_empty() {
                    msg.push_str(&format!(" Try: {}", names.join(", ")));
                }
                BotResponse::text(msg).ephemeral()
            }
        }
    }
}
