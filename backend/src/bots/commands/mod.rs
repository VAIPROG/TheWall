pub mod account;
pub mod wall;
use crate::bots::core::command::Command;
pub fn all_commands() -> Vec<Box<dyn Command>> {
    vec![
        Box::new(wall::Wall),
        Box::new(wall::Snapshot),
        Box::new(wall::Region),
        Box::new(account::Help),
        Box::new(account::Me),
        Box::new(account::Link),
    ]
}
