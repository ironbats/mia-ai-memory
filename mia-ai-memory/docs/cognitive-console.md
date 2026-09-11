# AI Memory Cognitive Console

## Objetivo

O Cognitive Console adiciona observabilidade cognitiva ao ai-memory sem substituir a fonte de verdade existente. Markdown/OKF, SQLite/FTS5, captura, consolidação e handoffs continuam no core. PostgreSQL funciona como read-model especializado para visualização, proveniência, histórico, correlação e diagnóstico.

## Arquitetura

```text
Agents
  -> ai-memory core
      -> Markdown/OKF
      -> SQLite/FTS5/entities/embeddings/graph
      -> /api/v1
          -> Cognitive Sync Service
              -> PostgreSQL
                  -> Cognitive API
                      -> React Cognitive Console
```

## Recursos implementados

- Neural Memory Graph com agentes, sessões, memórias, entidades e relações cross-project.
- Provenance Agent -> Session -> Memory em todas as páginas produzidas pela consolidação multi-page.
- Memory Health Center com stale, duplicadas, órfãs e contradições reais.
- Memory Optimization com priorização de contradições, stale, duplicatas, órfãs e memórias sem provenance.
- Agent Intelligence com sessões, observações, memórias produzidas e atividade MCP.
- Handoff Flow com origem, destino, estado, resumo e arquivos envolvidos.
- Live Cognitive Activity com atualização periódica no frontend.
- Memory Time Travel com versionamento imutável no PostgreSQL.
- Retrieval Explainability usando RRF real do core para FTS, entidades, grafo e stream vetorial quando uma query embedding é configurada.
- PostgreSQL read-model com snapshots de saúde e traces de recuperação.
- Sincronização incremental de páginas baseada em `updated_at`.
- Backend local isolado em Docker Compose, contendo apenas ai-memory core, PostgreSQL e Cognitive API.
- Frontend React mantido em repositório separado e conectado à Cognitive API por HTTP.
- Agent & MCP Registry para cadastrar agentes por API key, MCP, modo híbrido ou integração externa sem alterar o core do Akita.
- Credential Vault com AES-256-GCM, campos secretos arbitrários, mascaramento de valores e rotação de credenciais sem retorno de plaintext pela API.

## Execução

O backend e o frontend são projetos independentes.

No repositório backend:

```bash
./script/run-local.sh
```

Na primeira execução, o script cria `docker/.env` a partir de `docker/cognitive.env.example`, valida Docker/Compose, faz o build e sobe somente:

```text
ai-memory
cognitive-db
cognitive-api
```

Endpoints locais:

```text
AI Memory Core: http://127.0.0.1:49374
Cognitive API: http://127.0.0.1:8787
Cognitive API health: http://127.0.0.1:8787/healthz
```

O React deve ser iniciado no repositório frontend pelo `script/run-local.sh` daquele projeto. Por padrão, ele usa `http://127.0.0.1:8787` como backend.

O Cognitive API sincroniza automaticamente após iniciar e repete o processo conforme `COGNITIVE_SYNC_INTERVAL_MS`. O `script/run-local.sh` também gera e persiste uma chave local de 32 bytes em `docker/.env` quando `COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64` estiver vazio.

## Sincronização manual

Sem `COGNITIVE_ADMIN_TOKEN`:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/cognitive/sync \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"default","project":"my-project"}'
```

Com `COGNITIVE_ADMIN_TOKEN`, envie também `X-Admin-Token`. A interface solicita o token somente quando o backend responder `403`.

## Busca vetorial explicável

A busca explicável funciona sem embedding usando FTS, entidades e grafo. Para habilitar o stream vetorial, configure um endpoint OpenAI-compatible de embeddings:

```text
COGNITIVE_EMBEDDING_BASE_URL=https://provider.example/v1
COGNITIVE_EMBEDDING_API_KEY=secret
COGNITIVE_EMBEDDING_PROVIDER=provider-name
COGNITIVE_EMBEDDING_MODEL=embedding-model
COGNITIVE_EMBEDDING_DIM=1536
```

O provider/model/dim devem ser compatíveis com os embeddings já persistidos pelo core.

## Endpoints

```text
GET  /api/v1/cognitive/scopes
GET  /api/v1/cognitive/summary
GET  /api/v1/cognitive/brain
GET  /api/v1/cognitive/health
GET  /api/v1/cognitive/agents
GET  /api/v1/cognitive/handoffs
GET  /api/v1/cognitive/activity
GET  /api/v1/cognitive/memories
GET  /api/v1/cognitive/memory
GET  /api/v1/cognitive/evolution
GET  /api/v1/cognitive/optimization
GET  /api/v1/cognitive/retrieval-traces
GET  /api/v1/cognitive/sync/status
POST /api/v1/cognitive/search/explain
POST /api/v1/cognitive/sync
GET  /api/v1/cognitive/integrations/summary
GET  /api/v1/cognitive/config/agents
POST /api/v1/cognitive/config/agents
PUT  /api/v1/cognitive/config/agents/:id
PATCH /api/v1/cognitive/config/agents/:id/status
DELETE /api/v1/cognitive/config/agents/:id
GET  /api/v1/cognitive/config/mcps
POST /api/v1/cognitive/config/mcps
PUT  /api/v1/cognitive/config/mcps/:id
PATCH /api/v1/cognitive/config/mcps/:id/status
DELETE /api/v1/cognitive/config/mcps/:id
GET  /api/v1/cognitive/config/credentials
POST /api/v1/cognitive/config/credentials
PUT  /api/v1/cognitive/config/credentials/:id
DELETE /api/v1/cognitive/config/credentials/:id
GET  /api/v1/cognitive/config/audit
```

## Persistência PostgreSQL

O read-model usa as tabelas:

```text
cognitive_scopes
cognitive_memories
cognitive_memory_versions
cognitive_relations
cognitive_sessions
cognitive_handoffs
cognitive_health_snapshots
cognitive_client_activity
cognitive_retrieval_traces
cognitive_sync_runs
cognitive_credentials
cognitive_mcp_servers
cognitive_agent_registry
cognitive_agent_mcp_bindings
cognitive_integration_audit
```

`cognitive_memory_versions` é append-only por `(workspace, project, path, source_updated_at)` e sustenta o Time Travel sem alterar o histórico do core.

## Segurança

O Cognitive API reutiliza o bearer token do ai-memory para ler o core. Operações mutáveis de agentes, MCPs, credenciais, auditoria e sync podem ser protegidas com `COGNITIVE_ADMIN_TOKEN`. Credenciais são cifradas com AES-256-GCM usando `COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64`; apenas nomes dos campos e valores mascarados são retornados pela API. O PostgreSQL não é publicado no host. A Cognitive API é publicada somente em loopback por padrão, e o frontend permanece em um projeto separado.

## Compatibilidade

A separação mantém o core e o read-model no backend. O Compose do backend não contém serviço, build context ou dependência do React. O frontend pode ser iniciado, atualizado e implantado de forma independente, apontando `COGNITIVE_API_URL` para a Cognitive API apropriada.
