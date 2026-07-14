pub mod account;
pub mod admin;
pub mod clan;
pub mod notify;
pub mod templates;
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
        Box::new(admin::Status),
        Box::new(admin::Users),
        Box::new(admin::Logs),
        Box::new(admin::Regions),
        Box::new(admin::Announce),
        Box::new(admin::Moderate),
        Box::new(clan::Clan),
        Box::new(clan::Roster),
        Box::new(clan::Applications),
        Box::new(clan::Clanchat),
        Box::new(notify::Subscribe),
        Box::new(notify::Unsubscribe),
        Box::new(templates::Template),
    ]
}
