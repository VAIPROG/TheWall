pub mod wall;
use crate::bots::core::command::Command;
pub fn all_commands() -> Vec<Box<dyn Command>> {
    vec![Box::new(wall::Wall)]   // more added in Task 5
}
