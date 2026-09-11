CREATE TABLE IF NOT EXISTS cognitive_agent_models (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES cognitive_agent_registry(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, model_id)
);

CREATE TABLE IF NOT EXISTS cognitive_chat_conversations (
    id UUID PRIMARY KEY,
    workspace TEXT NOT NULL,
    project TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Nova conversa',
    default_agent_id UUID REFERENCES cognitive_agent_registry(id) ON DELETE SET NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cognitive_chat_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES cognitive_chat_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    agent_id UUID REFERENCES cognitive_agent_registry(id) ON DELETE SET NULL,
    provider TEXT,
    model TEXT,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'completed',
    memory_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    CHECK (status IN ('queued', 'running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS cognitive_chat_attachments (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES cognitive_chat_conversations(id) ON DELETE CASCADE,
    message_id UUID REFERENCES cognitive_chat_messages(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'application/zip',
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    content BYTEA NOT NULL,
    manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
    text_context TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cognitive_chat_agent_state (
    conversation_id UUID NOT NULL REFERENCES cognitive_chat_conversations(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES cognitive_agent_registry(id) ON DELETE CASCADE,
    external_thread_id TEXT,
    external_run_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_agent_models_agent ON cognitive_agent_models (agent_id, enabled, is_default DESC, display_name);
CREATE INDEX IF NOT EXISTS idx_cognitive_chat_conversations_scope ON cognitive_chat_conversations (workspace, project, archived, (COALESCE(last_message_at, created_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_chat_messages_conversation ON cognitive_chat_messages (conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_cognitive_chat_messages_search ON cognitive_chat_messages USING GIN (to_tsvector('simple', COALESCE(content, '')));
CREATE INDEX IF NOT EXISTS idx_cognitive_chat_attachments_conversation ON cognitive_chat_attachments (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cognitive_chat_attachments_message ON cognitive_chat_attachments (message_id, created_at);

INSERT INTO cognitive_agent_registry (
    id, name, description, connection_type, provider, model, base_url, workspace, project,
    observed_agent_kind, credential_id, settings, enabled
) VALUES
    ('a1000000-0000-4000-8000-000000000001', 'GPT', 'Agente OpenAI padrão para execução no chat independente do AI Memory.', 'api-key', 'OpenAI', 'gpt-6-astra', 'https://api.openai.com/v1', NULL, NULL, 'codex', NULL, '{"adapter":"openai-responses","systemDefault":true,"memoryCapture":true}'::jsonb, TRUE),
    ('a1000000-0000-4000-8000-000000000002', 'Claude', 'Agente Anthropic padrão para execução no chat independente do AI Memory.', 'api-key', 'Anthropic', 'claude-sonnet-5', 'https://api.anthropic.com/v1', NULL, NULL, 'claude-code', NULL, '{"adapter":"anthropic-messages","systemDefault":true,"memoryCapture":true}'::jsonb, TRUE),
    ('a1000000-0000-4000-8000-000000000003', 'Gemini', 'Agente Google Gemini padrão para execução no chat independente do AI Memory.', 'api-key', 'Google Gemini', 'gemini-3.8-flash', 'https://generativelanguage.googleapis.com/v1beta', NULL, NULL, 'gemini-cli', NULL, '{"adapter":"gemini-generate-content","systemDefault":true,"memoryCapture":true}'::jsonb, TRUE),
    ('a1000000-0000-4000-8000-000000000004', 'Cursor', 'Agente Cursor Cloud padrão para execução de tarefas de engenharia com continuidade pelo AI Memory.', 'api-key', 'Cursor', 'composer-2', 'https://api.cursor.com/v1', NULL, NULL, 'cursor', NULL, '{"adapter":"cursor-cloud","systemDefault":true,"memoryCapture":true,"cursor":{"repositoryUrl":"","startingRef":"main","conversationMode":"agent","autoCreatePR":false}}'::jsonb, TRUE),
    ('a1000000-0000-4000-8000-000000000005', 'Grok', 'Agente xAI padrão para execução no chat independente do AI Memory.', 'api-key', 'xAI', 'grok-4.6', 'https://api.x.ai/v1', NULL, NULL, 'grok', NULL, '{"adapter":"xai-responses","systemDefault":true,"memoryCapture":true}'::jsonb, TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO cognitive_agent_models (id, agent_id, provider, model_id, display_name, capabilities, settings, is_default, enabled)
SELECT seed.id::uuid, agent.id, seed.provider, seed.model_id, seed.display_name, seed.capabilities::jsonb, seed.settings::jsonb, seed.is_default, TRUE
FROM (
    VALUES
        ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'GPT', 'OpenAI', 'gpt-6-astra', 'GPT-6 Astra', '{"reasoning":true,"tools":true,"coding":true}', '{}', TRUE),
        ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'GPT', 'OpenAI', 'gpt-5.6-sol', 'GPT-5.6 Sol', '{"reasoning":true,"tools":true,"coding":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', 'GPT', 'OpenAI', 'gpt-5.6-terra', 'GPT-5.6 Terra', '{"reasoning":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001', 'GPT', 'OpenAI', 'gpt-5.6-luna', 'GPT-5.6 Luna', '{"reasoning":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-opus-5', 'Claude Opus 5', '{"reasoning":true,"coding":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', '{"reasoning":true,"coding":true,"tools":true}', '{}', TRUE),
        ('b1000000-0000-4000-8000-000000000012', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-fable-5', 'Claude Fable 5', '{"reasoning":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', '{"reasoning":true,"coding":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000014', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '{"reasoning":true,"coding":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000015', 'a1000000-0000-4000-8000-000000000002', 'Claude', 'Anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '{"reasoning":true,"tools":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000020', 'a1000000-0000-4000-8000-000000000003', 'Gemini', 'Google Gemini', 'gemini-3.8-flash', 'Gemini 3.8 Flash', '{"reasoning":true,"coding":true,"tools":true,"longContext":true}', '{}', TRUE),
        ('b1000000-0000-4000-8000-000000000021', 'a1000000-0000-4000-8000-000000000003', 'Gemini', 'Google Gemini', 'gemini-3.7-flash', 'Gemini 3.7 Flash', '{"reasoning":true,"tools":true,"longContext":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000022', 'a1000000-0000-4000-8000-000000000003', 'Gemini', 'Google Gemini', 'gemini-3.6-flash', 'Gemini 3.6 Flash', '{"reasoning":true,"tools":true,"longContext":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000023', 'a1000000-0000-4000-8000-000000000003', 'Gemini', 'Google Gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash', '{"reasoning":true,"tools":true,"longContext":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000024', 'a1000000-0000-4000-8000-000000000003', 'Gemini', 'Google Gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', '{"reasoning":true,"longContext":true}', '{}', FALSE),
        ('b1000000-0000-4000-8000-000000000030', 'a1000000-0000-4000-8000-000000000004', 'Cursor', 'Cursor', 'composer-2', 'Composer 2', '{"coding":true,"tools":true,"repository":true}', '{"dynamicCatalog":true}', TRUE),
        ('b1000000-0000-4000-8000-000000000031', 'a1000000-0000-4000-8000-000000000004', 'Cursor', 'Cursor', 'claude-4-sonnet-thinking', 'Claude 4 Sonnet Thinking', '{"coding":true,"tools":true,"repository":true}', '{"dynamicCatalog":true}', FALSE),
        ('b1000000-0000-4000-8000-000000000040', 'a1000000-0000-4000-8000-000000000005', 'Grok', 'xAI', 'grok-4.6', 'Grok 4.6', '{"reasoning":true,"tools":true,"coding":true}', '{}', TRUE),
        ('b1000000-0000-4000-8000-000000000041', 'a1000000-0000-4000-8000-000000000005', 'Grok', 'xAI', 'grok-4.3', 'Grok 4.3', '{"reasoning":true,"tools":true}', '{}', FALSE)
) AS seed(id, agent_id, agent_name, provider, model_id, display_name, capabilities, settings, is_default)
JOIN cognitive_agent_registry agent ON agent.id = seed.agent_id::uuid AND agent.name = seed.agent_name
ON CONFLICT DO NOTHING;
