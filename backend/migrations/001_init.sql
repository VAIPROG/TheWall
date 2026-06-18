-- Migration 001: Initial schema for The Wall Dev backend
-- Companion service for the pixel canvas browser extension

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users authenticated via filianislost.com site tokens
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wall_id     TEXT UNIQUE NOT NULL,
    username    TEXT NOT NULL,
    discord_id  TEXT,
    role        TEXT NOT NULL DEFAULT 'member',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_wall_id  ON users (wall_id);
CREATE INDEX idx_users_username ON users (username);

-- Auth sessions with hashed tokens
CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    refresh_hash TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);

-- Clan chat messages
CREATE TABLE clan_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clan_messages_user_id ON clan_messages (user_id);

-- Shared pixel art templates
CREATE TABLE templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    x          INT NOT NULL,
    y          INT NOT NULL,
    scale      INT NOT NULL DEFAULT 1,
    scope      TEXT NOT NULL DEFAULT 'clan',
    status     TEXT NOT NULL DEFAULT 'pending',
    share      TEXT NOT NULL,
    author     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_templates_user_id      ON templates (user_id);
CREATE INDEX idx_templates_scope_status ON templates (scope, status);

-- Reports filed against templates
CREATE TABLE template_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_template_reports_template_id ON template_reports (template_id);
CREATE INDEX idx_template_reports_user_id     ON template_reports (user_id);

-- Custom user avatars (one row per user)
CREATE TABLE avatars (
    user_id    UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    image      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- In-app notifications
CREATE TABLE notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT,
    read       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications (user_id);

-- Moderation role applications
CREATE TABLE moderation_applications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_moderation_applications_user_id ON moderation_applications (user_id);
