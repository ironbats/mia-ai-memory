CREATE TABLE IF NOT EXISTS cognitive_chat_skills (
    id UUID PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace, project, file_name)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_chat_skills_scope ON cognitive_chat_skills (workspace, project, enabled, updated_at DESC);
