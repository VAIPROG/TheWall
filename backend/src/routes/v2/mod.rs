//! V2 routes.
//!
//! v1 lives at /api/* — frozen, no behavioural changes after this point.
//! v2 lives at /api/v2/* and gets the rich data shapes, the two-axis role
//! model, and all the new features (mailbox, modmail, profiles, etc.).
//!
//! Both share /api/auth/*, /api/meta, /api/i18n/*, /api/avatar — those are
//! single-shape endpoints that don't benefit from versioning.

pub mod achievements;
pub mod admin_config;
pub mod admin_links;
pub mod anim;
pub mod auth;
pub mod clans;
pub mod feed;
pub mod links;
pub mod mailbox;
pub mod notifications;
pub mod permissions;
pub mod profile;
pub mod regions;
pub mod reminders;
pub mod signals_view;
pub mod template_backfill;
pub mod template_preview;
pub mod templates;
pub mod vai_auth;
