use crate::bots::core::command::{Command, CommandCtx};
use crate::bots::core::permissions::Permission;
use crate::bots::core::response::{BotResponse, Block};

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
