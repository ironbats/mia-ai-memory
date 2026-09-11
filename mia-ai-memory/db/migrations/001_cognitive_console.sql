CREATE TABLE IF NOT EXISTS cognitive_scopes (
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    page_count BIGINT NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace, project)
);

CREATE TABLE IF NOT EXISTS cognitive_memories (
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ,
    source_session_id TEXT,
    source_agent TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
    body_markdown TEXT NOT NULL DEFAULT '',
    stale BOOLEAN NOT NULL DEFAULT FALSE,
    duplicate BOOLEAN NOT NULL DEFAULT FALSE,
    orphan BOOLEAN NOT NULL DEFAULT FALSE,
    contradiction BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_run_id UUID,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace, project, path)
);

CREATE TABLE IF NOT EXISTS cognitive_memory_versions (
    id BIGSERIAL PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL,
    source_updated_at TIMESTAMPTZ NOT NULL,
    source_session_id TEXT,
    source_agent TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
    body_markdown TEXT NOT NULL DEFAULT '',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace, project, path, source_updated_at)
);

CREATE TABLE IF NOT EXISTS cognitive_relations (
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    from_path TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    to_workspace TEXT NOT NULL,
    to_project TEXT NOT NULL,
    to_path TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_run_id UUID,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace, project, from_path, relation_type, to_workspace, to_project, to_path)
);

CREATE TABLE IF NOT EXISTS cognitive_sessions (
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    cwd TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    observation_count BIGINT NOT NULL DEFAULT 0,
    actor_user TEXT,
    last_sync_run_id UUID,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace, project, session_id)
);

CREATE TABLE IF NOT EXISTS cognitive_handoffs (
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    handoff_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TIMESTAMPTZ,
    summary TEXT,
    open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
    next_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    files_touched JSONB NOT NULL DEFAULT '[]'::jsonb,
    cwd TEXT,
    owner_name TEXT,
    accepted_by TEXT,
    accepted_at TIMESTAMPTZ,
    redacted BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_run_id UUID,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace, project, handoff_id)
);

CREATE TABLE IF NOT EXISTS cognitive_health_snapshots (
    id BIGSERIAL PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    score INTEGER NOT NULL,
    stale BIGINT NOT NULL DEFAULT 0,
    duplicates BIGINT NOT NULL DEFAULT 0,
    contradictions BIGINT NOT NULL DEFAULT 0,
    orphans BIGINT NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cognitive_client_activity (
    client TEXT PRIMARY KEY,
    reads BIGINT NOT NULL DEFAULT 0,
    writes BIGINT NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cognitive_retrieval_traces (
    id BIGSERIAL PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    query TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    rank DOUBLE PRECISION NOT NULL,
    explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cognitive_sync_runs (
    run_id UUID PRIMARY KEY,
    workspace TEXT,
    project TEXT,
    status TEXT NOT NULL,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cognitive_memories_scope_updated ON cognitive_memories (workspace, project, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_memory_versions_scope_path ON cognitive_memory_versions (workspace, project, path, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_memories_agent ON cognitive_memories (workspace, project, source_agent);
CREATE INDEX IF NOT EXISTS idx_cognitive_memories_session ON cognitive_memories (workspace, project, source_session_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_memories_health ON cognitive_memories (workspace, project, stale, duplicate, orphan, contradiction);
CREATE INDEX IF NOT EXISTS idx_cognitive_relations_scope ON cognitive_relations (workspace, project, from_path);
CREATE INDEX IF NOT EXISTS idx_cognitive_sessions_scope_started ON cognitive_sessions (workspace, project, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_handoffs_scope_created ON cognitive_handoffs (workspace, project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_health_scope_captured ON cognitive_health_snapshots (workspace, project, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_retrieval_scope_created ON cognitive_retrieval_traces (workspace, project, created_at DESC);
