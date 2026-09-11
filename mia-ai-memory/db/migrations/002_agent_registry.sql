CREATE TABLE IF NOT EXISTS cognitive_credentials (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'api-key',
    provider TEXT,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    masked_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cognitive_mcp_servers (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL,
    endpoint_url TEXT,
    command TEXT,
    args JSONB NOT NULL DEFAULT '[]'::jsonb,
    public_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    public_env JSONB NOT NULL DEFAULT '{}'::jsonb,
    auth_type TEXT NOT NULL DEFAULT 'none',
    credential_id UUID REFERENCES cognitive_credentials(id) ON DELETE SET NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (transport IN ('streamable-http', 'sse', 'stdio')),
    CHECK (
        (transport IN ('streamable-http', 'sse') AND endpoint_url IS NOT NULL AND BTRIM(endpoint_url) <> '')
        OR
        (transport = 'stdio' AND command IS NOT NULL AND BTRIM(command) <> '')
    )
);

CREATE TABLE IF NOT EXISTS cognitive_agent_registry (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    connection_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    base_url TEXT,
    workspace TEXT,
    project TEXT,
    observed_agent_kind TEXT NOT NULL DEFAULT '',
    credential_id UUID REFERENCES cognitive_credentials(id) ON DELETE SET NULL,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (connection_type IN ('api-key', 'mcp', 'hybrid', 'external'))
);

CREATE TABLE IF NOT EXISTS cognitive_agent_mcp_bindings (
    agent_id UUID NOT NULL REFERENCES cognitive_agent_registry(id) ON DELETE CASCADE,
    mcp_id UUID NOT NULL REFERENCES cognitive_mcp_servers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, mcp_id)
);

CREATE TABLE IF NOT EXISTS cognitive_integration_audit (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    resource_name TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cognitive_credentials_provider ON cognitive_credentials (provider, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_mcp_servers_enabled ON cognitive_mcp_servers (enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_agents_enabled ON cognitive_agent_registry (enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_agents_scope ON cognitive_agent_registry (workspace, project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_agent_mcp_mcp ON cognitive_agent_mcp_bindings (mcp_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_cognitive_integration_audit_created ON cognitive_integration_audit (created_at DESC);
