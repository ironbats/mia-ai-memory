<div align="center">

# 🧠 AI Memory Cognitive Platform

### Memória compartilhada, observabilidade cognitiva e continuidade real entre agentes de IA

**Troque de GPT para Claude, Gemini, Cursor ou Grok sem perder o contexto do trabalho.**  
O agente executa. **A memória pertence ao projeto.**

![Core](https://img.shields.io/badge/AI%20Memory%20Core-Rust%202.1.1-6f5cff?style=for-the-badge&logo=rust&logoColor=white)
![Cognitive API](https://img.shields.io/badge/Cognitive%20API-Node.js%2022+-4b8cff?style=for-the-badge&logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791?style=for-the-badge&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-19.3-61DAFB?style=for-the-badge&logo=react&logoColor=111)
![Vite](https://img.shields.io/badge/Vite-8.2-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![License](https://img.shields.io/badge/Core%20License-MIT-22c55e?style=for-the-badge)

</div>

---

## Visão geral

O **AI Memory Cognitive Platform** adiciona uma camada visual, operacional e multiagente ao [`ai-memory`](https://github.com/akitaonrails/ai-memory), mantendo o princípio mais importante do projeto original:

> **memória durável não deve pertencer a um único agente ou provedor.**

A solução é dividida em **dois projetos independentes**:

| Projeto | Responsabilidade |
|---|---|
| **AI Memory Backend API** | Core de memória em Rust, Cognitive API em Node.js, PostgreSQL read-model, chat multiagente, agentes, MCPs, credenciais, sincronização e observabilidade |
| **AI Memory Frontend App** | Cognitive Console em React com Neural Brain, Memory Health, agentes, MCPs, handoffs, Time Travel, Explain Search e chat persistente |

O backend preserva o **core original em Rust** como fonte de verdade da memória. O PostgreSQL não substitui o Core: ele funciona como um **read-model cognitivo especializado** para visualização, métricas, histórico, proveniência, busca explicável e configuração operacional.

---

# ✨ O que a plataforma resolve

### Antes

```text
Claude tem sua memória
GPT tem outra memória
Cursor tem outro contexto
Gemini começa do zero
Grok não sabe o que aconteceu

Trocar de agente = reexplicar o projeto.
```

### Com AI Memory

```text
                   ┌──────────────────────┐
                   │   SHARED AI MEMORY   │
                   │  conhecimento comum  │
                   └──────────┬───────────┘
          ┌───────────────────┼───────────────────┐
          │                   │                   │
        GPT                 Claude             Gemini
          │                   │                   │
          ├──────── Cursor ────┼──── Grok ────────┤
          │                   │                   │
          └──────── todos reutilizam a mesma memória ────────┘
```

O resultado é **continuidade entre agentes, sessões, máquinas e ferramentas**, com rastreabilidade de como a informação foi criada, consolidada e recuperada.

---

# 🏗️ Arquitetura de alto nível

```mermaid
flowchart LR
    DEV["👨‍💻 Developer"] --> UI["🖥️ React Cognitive Console"]

    UI --> API["⚡ Cognitive API<br/>Node.js 22+"]
    UI --> CHAT["💬 Multi-Agent Chat"]

    CHAT --> API
    API --> PG[("🐘 PostgreSQL 17<br/>Cognitive Read Model")]
    API --> CORE["🧠 AI Memory Core<br/>Rust 2.1.1"]

    CORE --> WIKI["📚 Git-backed Markdown Wiki<br/>Source of Truth"]
    CORE --> SQLITE[("⚙️ SQLite / FTS5<br/>Entities · Graph · Embeddings")]
    CORE --> HOOKS["🔌 Lifecycle Hooks / MCP"]

    HOOKS --> AGENTS["🤖 External Coding Agents<br/>Claude · Codex · Cursor · Gemini · Grok · ..."]

    API --> VAULT["🔐 Credential Vault<br/>AES-256-GCM"]
    API --> REGISTRY["🧩 Agent & MCP Registry"]

    REGISTRY --> PROVIDERS["☁️ LLM Providers<br/>OpenAI · Anthropic · Google · xAI · Cursor"]
    VAULT --> PROVIDERS

    style CORE fill:#211a4d,stroke:#8b7cff,color:#fff
    style PG fill:#0c2745,stroke:#4b8cff,color:#fff
    style UI fill:#102035,stroke:#61dafb,color:#fff
    style API fill:#11291c,stroke:#22c55e,color:#fff
```

---

# 🧠 Princípio arquitetural central

A arquitetura separa quatro conceitos que normalmente ficam acoplados em aplicações de chat:

```mermaid
flowchart LR
    C["Conversation<br/>identidade estável"] --> M["Memory<br/>contexto durável"]
    M --> A["Agent<br/>executor substituível"]
    A --> L["Model<br/>modelo por turno"]
    L --> R["Response<br/>resultado"]
    R --> C

    style C fill:#17152d,stroke:#8b7cff,color:#fff
    style M fill:#241b55,stroke:#9b8cff,color:#fff
    style A fill:#12233a,stroke:#4b8cff,color:#fff
    style L fill:#172a22,stroke:#22c55e,color:#fff
```

**A conversa não pertence ao GPT, Claude ou qualquer outro provedor.**  
O agente/modelo é apenas o executor daquele turno.

Isso permite:

- trocar de agente durante a mesma conversa;
- trocar de modelo sem recriar contexto;
- recuperar decisões antigas do projeto;
- carregar contexto de outras conversas relevantes;
- anexar ZIPs de código;
- capturar a resposta novamente no AI Memory Core;
- manter continuidade mesmo quando o executor muda.

---

# 🔄 Ciclo completo da memória

```mermaid
flowchart TD
    P["1. Prompt / Tool Event"] --> H["2. Lifecycle Hook / Web Chat"]
    H --> C["3. Capture"]
    C --> O["4. Observations"]
    O --> CON["5. Consolidation"]
    CON --> MD["6. Markdown Wiki"]
    MD --> IDX["7. SQLite / FTS5 / Entities / Graph"]
    IDX --> REC["8. Recall / Explained Search"]
    REC --> CTX["9. Context Injection"]
    CTX --> AG["10. Agent Execution"]
    AG --> RESP["11. Response"]
    RESP --> C

    MD --> SYNC["Cognitive Sync"]
    SYNC --> PG[("PostgreSQL Read Model")]
    PG --> UI["Neural Brain / Health / Time Travel"]

    style MD fill:#241b55,stroke:#9b8cff,color:#fff
    style PG fill:#0c2745,stroke:#4b8cff,color:#fff
```

O **Markdown Wiki continua sendo a fonte de verdade**.  
SQLite e PostgreSQL são índices/read-models derivados e podem ser reconstruídos.

---

# 💬 Web Chat multiagente

O frontend possui um chat persistente lado a lado com o Cognitive Console.

Cada turno pode utilizar um agente e modelo diferentes sem perder a identidade da conversa.

## Contexto montado por turno

O backend combina:

```text
Recent conversation history
        +
Relevant old messages from the same/project conversations
        +
Consolidated AI Memory pages
        +
ZIP attachment textual context
        ↓
System context
        ↓
Selected Agent / Model
```

## Sequência de execução

```mermaid
sequenceDiagram
    actor User
    participant UI as React Chat
    participant API as Cognitive API
    participant PG as PostgreSQL
    participant Core as AI Memory Core
    participant LLM as Selected Agent/Provider

    User->>UI: Envia prompt
    UI->>API: POST /chat/conversations/:id/messages
    API->>PG: Carrega conversa + histórico
    API->>Core: Explained Search
    Core-->>API: Memórias relevantes
    API->>PG: Busca mensagens antigas relevantes
    API->>PG: Carrega anexos ZIP
    API->>LLM: Prompt + memória + histórico + anexos
    LLM-->>API: Resposta
    API->>PG: Persiste resposta + metadata
    API->>Core: /hook/batch
    Core-->>API: Captura confirmada/degradada
    API-->>UI: Mensagem completa
    UI-->>User: Renderiza resposta
```

---

# 🕸️ Neural Brain

O **Neural Brain** representa visualmente a memória compartilhada entre agentes.

```mermaid
graph TD
    CORE(("🧠 MEMÓRIA<br/>COMPARTILHADA"))

    GPT["GPT"]
    CLAUDE["Claude"]
    GEMINI["Gemini"]
    CURSOR["Cursor"]
    GROK["Grok"]

    S1["Session"]
    S2["Session"]
    M1["Memory"]
    M2["Memory"]
    E1["Entity"]
    E2["Entity"]

    GPT --> CORE
    CLAUDE --> CORE
    GEMINI --> CORE
    CURSOR --> CORE
    GROK --> CORE

    GPT --> S1 --> M1 --> E1
    CLAUDE --> S2 --> M2 --> E2

    M1 -. shared context .-> CORE
    M2 -. shared context .-> CORE

    style CORE fill:#2b2263,stroke:#9b8cff,color:#fff,stroke-width:3px
    style GPT fill:#15192a,stroke:#8b7cff,color:#fff
    style CLAUDE fill:#15192a,stroke:#8b7cff,color:#fff
    style GEMINI fill:#15192a,stroke:#8b7cff,color:#fff
    style CURSOR fill:#15192a,stroke:#8b7cff,color:#fff
    style GROK fill:#15192a,stroke:#8b7cff,color:#fff
```

### Tipos de nós

| Nó | Significado |
|---|---|
| `AGENT` | Agente que produziu ou consumiu contexto |
| `SESSION` | Sessão observada pelo Core |
| `MEMORY` | Página consolidada de conhecimento |
| `ENTITY` | Entidade extraída da memória |
| `EXTERNAL` | Relação com memória fora do projeto atual |

### Tipos de relações

| Relação | Significado |
|---|---|
| `produced-session` | Agente originou uma sessão |
| `produced-memory` | Sessão/agente produziu uma memória |
| `entity` | Memória referencia uma entidade |
| relações tipadas do Core | Links entre páginas, inclusive cross-project |

---

# 📊 Cognitive Read Model

O PostgreSQL foi adicionado para responder perguntas que o frontend precisa fazer com baixa latência e boa rastreabilidade.

```mermaid
flowchart LR
    CORE["AI Memory Core API"] --> SYNC["Cognitive Sync Service"]
    SYNC --> SCOPE["Scopes"]
    SYNC --> MEM["Memories"]
    SYNC --> SES["Sessions"]
    SYNC --> HAN["Handoffs"]
    SYNC --> HEALTH["Health"]
    SYNC --> REL["Relations"]
    SYNC --> ACT["Client Activity"]

    SCOPE --> PG[("PostgreSQL")]
    MEM --> PG
    SES --> PG
    HAN --> PG
    HEALTH --> PG
    REL --> PG
    ACT --> PG

    PG --> DASH["Dashboard"]
    PG --> BRAIN["Neural Brain"]
    PG --> TT["Time Travel"]
    PG --> SEARCH["Explain Search"]
```

O sync é iniciado automaticamente após o startup e se repete conforme:

```text
COGNITIVE_SYNC_INTERVAL_MS=30000
```

A concorrência de sincronização de páginas é controlada por:

```text
COGNITIVE_SYNC_PAGE_CONCURRENCY=8
```

---

# 📈 Indicadores de observabilidade

O console expõe uma visão operacional da qualidade da memória.

| Indicador | O que responde |
|---|---|
| **Memórias** | Quantas páginas cognitivas existem no projeto |
| **Provenance** | Quantas memórias possuem ligação rastreável com sessão/agente |
| **Sessões** | Quantas sessões foram observadas e quantas observações produziram |
| **Contradições** | Quantas memórias foram identificadas como contraditórias |
| **Handoffs** | Quantas transferências de contexto existem e quantas continuam abertas |
| **Último Sync** | Estado da última materialização do Core para o read-model |
| **Stale** | Memórias potencialmente desatualizadas |
| **Duplicate** | Memórias possivelmente duplicadas |
| **Orphan** | Memórias sem relações adequadas |
| **Retrieval traces** | Como e por que uma memória apareceu em uma busca |

---

# 🔎 Explainable Retrieval

A busca explicável combina sinais do Core e persiste traces no PostgreSQL.

```mermaid
flowchart TD
    Q["Query"] --> FTS["FTS"]
    Q --> ENT["Entities"]
    Q --> GRAPH["Graph"]
    Q --> VEC["Vector Stream<br/>optional"]

    FTS --> RRF["Rank Fusion / Core Explain"]
    ENT --> RRF
    GRAPH --> RRF
    VEC --> RRF

    RRF --> RESULT["Ranked Memories"]
    RESULT --> TRACE["Retrieval Trace"]
    TRACE --> PG[("PostgreSQL")]
    TRACE --> UI["Explain Search UI"]
```

O stream vetorial é opcional. Sem embeddings externos, FTS, entidades e grafo continuam disponíveis.

---

# 🧩 Módulos do Frontend

| Módulo | Objetivo |
|---|---|
| **Neural Brain** | Visualizar agentes, sessões, memórias, entidades e relações |
| **Memory Health** | Encontrar stale, duplicadas, órfãs e contradições |
| **Configurar Agentes** | Agentes, MCPs, credenciais, providers, modelos e bindings |
| **Activity & Handoffs** | Atividade recente e transferência de contexto entre agentes |
| **Time Travel** | Histórico imutável das versões de uma memória |
| **Explain Search** | Entender por que determinada memória foi recuperada |
| **Persistent Web Chat** | Conversa independente do agente, com memória compartilhada e ZIPs |
| **Optimization** | Recomendações para corrigir memória degradada |

---

# 🤖 Agent & MCP Registry

A plataforma possui um registry operacional separado do Core.

Um agente pode ser configurado como:

| Tipo | Uso |
|---|---|
| `api-key` | Execução direta via API de provider |
| `mcp` | Agente conectado por MCP |
| `hybrid` | Combinação de API e MCP |
| `external` | Integração externa sem execução direta pelo Web Chat |

### MCP transports

- Streamable HTTP
- SSE
- stdio

Um agente pode estar ligado a múltiplos MCPs.

```mermaid
erDiagram
    COGNITIVE_CREDENTIALS ||--o{ COGNITIVE_AGENT_REGISTRY : "used by"
    COGNITIVE_CREDENTIALS ||--o{ COGNITIVE_MCP_SERVERS : "used by"
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_AGENT_MCP_BINDINGS : "binds"
    COGNITIVE_MCP_SERVERS ||--o{ COGNITIVE_AGENT_MCP_BINDINGS : "binds"
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_AGENT_MODELS : "has"
```

---

# 🧠 Agentes default

A migration `003_chat_and_default_agents.sql` cria cinco agentes default.  
Depois do bootstrap, basta associar as credenciais necessárias.

| Agente | Provider | Modelo default | Adapter |
|---|---|---|---|
| **GPT** | OpenAI | `gpt-6-astra` | `openai-responses` |
| **Claude** | Anthropic | `claude-sonnet-5` | `anthropic-messages` |
| **Gemini** | Google Gemini | `gemini-3.8-flash` | `gemini-generate-content` |
| **Cursor** | Cursor | `composer-2` | `cursor-cloud` |
| **Grok** | xAI | `grok-4.6` | `xai-responses` |

A mesma migration cadastra **19 modelos** no catálogo inicial.

> Os identificadores são seeds de configuração da plataforma. A disponibilidade real de cada modelo depende da conta, região e API do provider configurado no momento da execução.

---

# 🔐 Credential Vault

Credenciais não são armazenadas em plaintext.

```mermaid
flowchart LR
    UI["Frontend"] --> API["Cognitive API"]
    API --> VAULT["AES-256-GCM"]
    VAULT --> PG[("Encrypted secrets")]
    PG --> VAULT
    VAULT --> EXEC["Runtime Agent"]
    EXEC --> PROVIDER["Provider API"]

    API -. "masked fields only" .-> UI
```

### Regras

- criptografia AES-256-GCM;
- chave mestra via `COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64`;
- valores secretos não são retornados novamente ao frontend;
- frontend recebe apenas metadados/valores mascarados;
- rotação de credencial sem exposição do plaintext anterior;
- credencial não pode ser removida enquanto estiver em uso por agente ou MCP.

O `script/run-local.sh` do backend gera automaticamente uma chave local de 32 bytes caso ela ainda não exista.

---

# 📦 ZIP attachments

O Web Chat suporta anexar projetos `.zip` e exportar uma conversa completa.

### Proteções implementadas

- limite de tamanho do ZIP;
- limite de quantidade de entradas;
- limite de tamanho descompactado;
- bloqueio de path traversal;
- bloqueio de symbolic links;
- bloqueio de ZIP criptografado;
- bloqueio de ZIP64;
- leitura contextual apenas de arquivos textuais suportados;
- exclusão de diretórios pesados como `node_modules`, `target`, `dist`, `.git`;
- `.env` e `.env.*` não entram no contexto enviado aos modelos;
- SHA-256 persistido para cada anexo.

### Defaults

| Variável | Default |
|---|---:|
| `COGNITIVE_CHAT_ATTACHMENT_MAX_BYTES` | 50 MiB |
| `COGNITIVE_CHAT_ZIP_MAX_ENTRIES` | 800 |
| `COGNITIVE_CHAT_ZIP_MAX_UNCOMPRESSED_BYTES` | 150 MiB |
| `COGNITIVE_CHAT_ATTACHMENT_CONTEXT_MAX_BYTES` | 384 KiB |
| `COGNITIVE_CHAT_HISTORY_LIMIT` | 24 mensagens |
| `COGNITIVE_CHAT_MEMORY_RECALL_LIMIT` | 6 memórias |

---

# 🗃️ Persistência

Existem **três camadas de persistência com responsabilidades diferentes**.

```mermaid
flowchart TB
    WIKI["Git-backed Markdown Wiki<br/>Canonical knowledge"] --> SQLITE["SQLite / FTS5<br/>Core derived index"]
    WIKI --> PG["PostgreSQL<br/>Cognitive read-model"]
    SQLITE --> CORE["AI Memory Core"]
    CORE --> PG

    PG --> OBS["Observability / Chat / Registry"]
```

## 1. Markdown Wiki

Fonte de verdade da memória consolidada.

- arquivos `.md`;
- versionamento Git;
- editável por ferramentas comuns;
- portável;
- independente de banco vetorial.

## 2. SQLite

Índice interno do Core.

- FTS5;
- entidades;
- relações;
- embeddings opcionais;
- operações do runtime do `ai-memory`.

## 3. PostgreSQL

Read-model e estado operacional da Cognitive Platform.

### Tabelas cognitivas

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
```

### Registry e segurança

```text
cognitive_credentials
cognitive_mcp_servers
cognitive_agent_registry
cognitive_agent_mcp_bindings
cognitive_integration_audit
cognitive_agent_models
```

### Web Chat

```text
cognitive_chat_conversations
cognitive_chat_messages
cognitive_chat_attachments
cognitive_chat_agent_state
```

Total atual: **20 tabelas PostgreSQL** distribuídas em três migrations.

---

# 🗺️ Modelo de dados simplificado

```mermaid
erDiagram
    COGNITIVE_SCOPES ||--o{ COGNITIVE_MEMORIES : contains
    COGNITIVE_MEMORIES ||--o{ COGNITIVE_MEMORY_VERSIONS : versions
    COGNITIVE_MEMORIES ||--o{ COGNITIVE_RELATIONS : relates
    COGNITIVE_SCOPES ||--o{ COGNITIVE_SESSIONS : observes
    COGNITIVE_SCOPES ||--o{ COGNITIVE_HANDOFFS : owns
    COGNITIVE_SCOPES ||--o{ COGNITIVE_HEALTH_SNAPSHOTS : measures
    COGNITIVE_SCOPES ||--o{ COGNITIVE_RETRIEVAL_TRACES : traces

    COGNITIVE_CREDENTIALS ||--o{ COGNITIVE_AGENT_REGISTRY : secures
    COGNITIVE_CREDENTIALS ||--o{ COGNITIVE_MCP_SERVERS : secures
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_AGENT_MODELS : exposes
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_AGENT_MCP_BINDINGS : binds
    COGNITIVE_MCP_SERVERS ||--o{ COGNITIVE_AGENT_MCP_BINDINGS : binds

    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_CHAT_CONVERSATIONS : defaults
    COGNITIVE_CHAT_CONVERSATIONS ||--o{ COGNITIVE_CHAT_MESSAGES : contains
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_CHAT_MESSAGES : executes
    COGNITIVE_CHAT_CONVERSATIONS ||--o{ COGNITIVE_CHAT_ATTACHMENTS : owns
    COGNITIVE_CHAT_MESSAGES ||--o{ COGNITIVE_CHAT_ATTACHMENTS : references
    COGNITIVE_CHAT_CONVERSATIONS ||--o{ COGNITIVE_CHAT_AGENT_STATE : tracks
    COGNITIVE_AGENT_REGISTRY ||--o{ COGNITIVE_CHAT_AGENT_STATE : tracks
```

---

# ⚙️ Stack tecnológica

## Backend

| Camada | Tecnologia |
|---|---|
| Core de memória | Rust 1.95+, Edition 2024 |
| Core version | `2.1.1` |
| Async | Tokio |
| HTTP Core | Axum |
| MCP | `rmcp` |
| Core storage | SQLite + FTS5 |
| Wiki | Markdown + Git (`git2`) |
| LLM HTTP | Reqwest |
| Cognitive API | Node.js 22+ |
| Cognitive API HTTP | `node:http` nativo |
| PostgreSQL client | `pg 8.23` |
| Cognitive DB | PostgreSQL 17 |
| Containers | Docker / Docker Compose |

## Frontend

| Camada | Tecnologia |
|---|---|
| UI | React 19.3 |
| Bundler/dev server | Vite 8.2 |
| Styling | CSS próprio |
| API | Fetch API |
| Build | Vite |
| Deploy container | Nginx |

---

# 📁 Estrutura dos dois projetos

## Backend

```text
ai-memory-backend/
├── crates/
│   ├── ai-memory-core/
│   ├── ai-memory-store/
│   ├── ai-memory-wiki/
│   ├── ai-memory-mcp/
│   ├── ai-memory-hooks/
│   ├── ai-memory-llm/
│   ├── ai-memory-consolidate/
│   ├── ai-memory-web/
│   ├── ai-memory-cli/
│   └── ai-memory-workstream/
├── services/
│   └── cognitive-api/
│       └── src/
│           ├── attachment-service.js
│           ├── chat-repository.js
│           ├── chat-service.js
│           ├── config.js
│           ├── core-client.js
│           ├── credential-vault.js
│           ├── embedding-client.js
│           ├── integration-repository.js
│           ├── integration-service.js
│           ├── llm-executor.js
│           ├── repository.js
│           ├── server.js
│           └── sync-service.js
├── db/
│   └── migrations/
│       ├── 001_cognitive_console.sql
│       ├── 002_agent_registry.sql
│       └── 003_chat_and_default_agents.sql
├── hooks/
├── docs/
├── docker/
├── script/
│   └── run-local.sh
└── Cargo.toml
```

## Frontend

```text
ai-memory-frontend/
├── src/
│   ├── components/
│   │   ├── ActivityFeed.jsx
│   │   ├── AgentEditor.jsx
│   │   ├── BrainGraph.jsx
│   │   ├── ChatWorkspace.jsx
│   │   ├── CredentialEditor.jsx
│   │   ├── EvolutionPanel.jsx
│   │   ├── HandoffFlow.jsx
│   │   ├── IntegrationHub.jsx
│   │   ├── McpEditor.jsx
│   │   ├── MemoryDrawer.jsx
│   │   ├── MessageContent.jsx
│   │   ├── MetricCard.jsx
│   │   ├── OptimizationPanel.jsx
│   │   └── SearchExplain.jsx
│   ├── lib/
│   │   └── api.js
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── script/
│   └── run-local.sh
├── Dockerfile
├── nginx.conf
├── package.json
└── vite.config.js
```

---

# 🚀 Quick Start

## Pré-requisitos

- Docker Engine ou Docker Desktop
- Docker Compose v2
- Node.js 22+
- npm
- Linux/macOS ou ambiente compatível com Docker

---

## 1. Subir o backend

No repositório backend:

```bash
./script/run-local.sh
```

Na primeira execução o script:

1. cria `docker/.env` a partir de `docker/cognitive.env.example`;
2. gera a chave mestra do Credential Vault se estiver vazia;
3. valida Docker e Compose;
4. builda os containers;
5. sobe Core, PostgreSQL e Cognitive API;
6. aguarda healthchecks.

Serviços locais:

| Serviço | URL |
|---|---|
| AI Memory Core | `http://127.0.0.1:49374` |
| Cognitive API | `http://127.0.0.1:8787` |
| Health | `http://127.0.0.1:8787/healthz` |

Containers:

```text
ai-memory
ai-memory-cognitive-db
ai-memory-cognitive-api
```

---

## 2. Subir o frontend

No repositório frontend:

```bash
./script/run-local.sh
```

URL default:

```text
http://127.0.0.1:5173
```

O backend default é:

```text
http://127.0.0.1:8787
```

Para apontar para outro ambiente:

```bash
COGNITIVE_API_URL=https://ai-memory-api.exemplo.com ./script/run-local.sh
```

O Vite faz proxy de:

```text
/api     -> Cognitive API
/healthz -> Cognitive API
```

---

# 🐳 Topologia Docker local

```mermaid
flowchart LR
    HOST["Host Browser<br/>:5173"] --> FE["Frontend Vite"]

    FE --> API["cognitive-api<br/>:8787"]
    API --> CORE["ai-memory<br/>:49374"]
    API --> DB[("cognitive-db<br/>PostgreSQL 17")]

    CORE --> VOL1[("ai-memory-data")]
    DB --> VOL2[("cognitive-postgres-data")]

    style CORE fill:#211a4d,stroke:#8b7cff,color:#fff
    style API fill:#11291c,stroke:#22c55e,color:#fff
    style DB fill:#0c2745,stroke:#4b8cff,color:#fff
```

O PostgreSQL não é publicado diretamente no host no Compose padrão.

---

# 🔧 Configuração do backend

Arquivo local:

```text
docker/.env
```

Base:

```text
docker/cognitive.env.example
```

### Core

| Variável | Default / finalidade |
|---|---|
| `AI_MEMORY_PORT` | `49374` |
| `AI_MEMORY_AUTH_TOKEN` | Bearer token opcional do Core |
| `AI_MEMORY_ALLOWED_HOSTS` | Hosts aceitos pelo Core |

### PostgreSQL / Cognitive API

| Variável | Default / finalidade |
|---|---|
| `COGNITIVE_DB_NAME` | `ai_memory` |
| `COGNITIVE_DB_USER` | `ai_memory` |
| `COGNITIVE_DB_PASSWORD` | senha local |
| `COGNITIVE_API_PORT` | `8787` |
| `COGNITIVE_ADMIN_TOKEN` | protege operações mutáveis |
| `CORS_ORIGIN` | `*` em local |

### Sync

| Variável | Default |
|---|---:|
| `COGNITIVE_SYNC_ENABLED` | `true` |
| `COGNITIVE_SYNC_INTERVAL_MS` | `30000` |
| `COGNITIVE_SYNC_PAGE_CONCURRENCY` | `8` |
| `COGNITIVE_BRAIN_NODE_LIMIT` | `320` |

### Embeddings opcionais

```text
COGNITIVE_EMBEDDING_BASE_URL=
COGNITIVE_EMBEDDING_API_KEY=
COGNITIVE_EMBEDDING_PROVIDER=
COGNITIVE_EMBEDDING_MODEL=
COGNITIVE_EMBEDDING_DIM=0
```

### Credential Vault

```text
COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64=
```

Em ambiente local, `run-local.sh` gera a chave automaticamente caso necessário.

---

# 🔌 API principal

Base local:

```text
http://127.0.0.1:8787
```

## Health

```http
GET /healthz
```

## Cognitive Console

```http
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
```

## Agent / MCP configuration

```http
GET    /api/v1/cognitive/integrations/summary

GET    /api/v1/cognitive/config/agents
POST   /api/v1/cognitive/config/agents
PUT    /api/v1/cognitive/config/agents/:id
PATCH  /api/v1/cognitive/config/agents/:id/status
DELETE /api/v1/cognitive/config/agents/:id

GET    /api/v1/cognitive/config/models

GET    /api/v1/cognitive/config/mcps
POST   /api/v1/cognitive/config/mcps
PUT    /api/v1/cognitive/config/mcps/:id
PATCH  /api/v1/cognitive/config/mcps/:id/status
DELETE /api/v1/cognitive/config/mcps/:id

GET    /api/v1/cognitive/config/credentials
POST   /api/v1/cognitive/config/credentials
PUT    /api/v1/cognitive/config/credentials/:id
DELETE /api/v1/cognitive/config/credentials/:id

GET    /api/v1/cognitive/config/audit
```

## Web Chat

```http
GET    /api/v1/cognitive/chat/bootstrap
POST   /api/v1/cognitive/chat/conversations
GET    /api/v1/cognitive/chat/conversations/:id
PATCH  /api/v1/cognitive/chat/conversations/:id
DELETE /api/v1/cognitive/chat/conversations/:id

POST   /api/v1/cognitive/chat/conversations/:id/messages
POST   /api/v1/cognitive/chat/conversations/:id/attachments
GET    /api/v1/cognitive/chat/conversations/:id/export
GET    /api/v1/cognitive/chat/attachments/:id/download
```

---

# 🔁 Sincronização manual

Sem `COGNITIVE_ADMIN_TOKEN`:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/cognitive/sync \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"default","project":"my-project"}'
```

Com token administrativo:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/cognitive/sync \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: SEU_TOKEN' \
  -d '{"workspace":"default","project":"my-project"}'
```

---

# 🧪 Comandos de desenvolvimento

## Backend Cognitive API

```bash
cd services/cognitive-api
npm install
npm run check
npm start
```

## Core Rust

```bash
cargo build
cargo test
```

## Frontend

```bash
npm install
npm run dev
npm run build
npm run preview
```

---

# 🛡️ Segurança

A plataforma aplica segurança em múltiplas fronteiras.

```mermaid
flowchart TD
    USER["User"] --> FE["Frontend"]
    FE --> ADMIN["Admin Token Boundary"]
    ADMIN --> API["Cognitive API"]

    API --> VAULT["Credential Vault"]
    VAULT --> ENC["AES-256-GCM"]

    API --> ZIP["ZIP Sanitization"]
    ZIP --> CTX["Safe Text Context"]

    API --> CORE["Core Bearer Token"]
    CORE --> PRIV["Typed Privacy / Sanitizer Boundary"]

    style ADMIN fill:#341928,stroke:#ff5c8a,color:#fff
    style VAULT fill:#172a22,stroke:#22c55e,color:#fff
    style ZIP fill:#2d2513,stroke:#f4c95d,color:#fff
```

### Controles existentes

- bearer token opcional entre Cognitive API e Core;
- `COGNITIVE_ADMIN_TOKEN` para mutações sensíveis;
- AES-256-GCM para credenciais;
- segredos mascarados no frontend;
- sem recuperação de plaintext;
- validação de URLs e tipos de integração;
- validação de MCP transport;
- limites de body HTTP;
- validação defensiva de ZIP;
- exclusão de `.env` do contexto;
- CORS configurável;
- PostgreSQL privado no Compose local;
- audit trail para integrações.

> Para produção, não use `CORS_ORIGIN=*`, defina tokens fortes e gerencie a chave mestra fora do repositório.

---

# 🧭 Fluxo de handoff

Handoff não é apenas texto informal: é um objeto rastreável de transferência de contexto.

```mermaid
sequenceDiagram
    participant A as Agent A
    participant Core as AI Memory Core
    participant DB as Cognitive Read Model
    participant B as Agent B

    A->>Core: Finaliza sessão
    Core->>Core: Consolida memória
    Core->>Core: Cria/atualiza handoff
    Core-->>DB: Sync
    B->>Core: Inicia nova sessão
    Core-->>B: Contexto + handoff
    B->>Core: Assume continuidade
```

O Cognitive Console exibe:

- origem;
- destino/estado;
- resumo;
- perguntas abertas;
- próximos passos;
- arquivos tocados;
- owner;
- aceite.

---

# ⏱️ Time Travel

`cognitive_memory_versions` é append-only por:

```text
(workspace, project, path, source_updated_at)
```

Isso permite inspecionar a evolução de uma memória sem alterar o histórico do Core.

```mermaid
gitGraph
    commit id: "Architecture v1"
    commit id: "Decision refined"
    branch agent-claude
    commit id: "New evidence"
    checkout main
    merge agent-claude
    commit id: "Consolidated memory"
```

---

# 🧹 Memory Health & Optimization

A plataforma separa diagnóstico de memória de execução dos agentes.

### Prioridades

```text
contradiction -> critical
stale         -> high
duplicate     -> high
orphan        -> medium
no provenance -> medium
```

### Ações sugeridas

```text
resolve-contradiction
refresh-stale-memory
merge-duplicate-memory
link-or-remove-orphan
add-provenance
review
```

---

# 🧱 Invariantes de arquitetura

Estes princípios devem ser preservados em qualquer evolução:

1. **O agente é substituível; a memória não é.**
2. **O Core continua sendo a fonte de verdade.**
3. **Markdown permanece portável e inspecionável.**
4. **PostgreSQL é read-model/estado operacional, não substituto do Wiki.**
5. **Uma conversa mantém identidade própria independentemente do provider.**
6. **Segredos nunca retornam em plaintext pela API.**
7. **Falha de memória consolidada não deve destruir o histórico do chat.**
8. **Dados recuperados e anexos são contexto não confiável, nunca instruções de maior prioridade.**
9. **Observabilidade precisa explicar origem, evolução e recuperação da memória.**
10. **Frontend e backend continuam implantáveis independentemente.**

---

# 🎯 Estado atual da plataforma

```text
Shared Memory Core          ████████████████████  ✓
Cross-Agent Continuity      ████████████████████  ✓
Cognitive Read Model        ████████████████████  ✓
Neural Brain                ████████████████████  ✓
Memory Health               ████████████████████  ✓
Agent Registry              ████████████████████  ✓
MCP Registry                ████████████████████  ✓
Credential Vault            ████████████████████  ✓
Multi-Agent Web Chat        ████████████████████  ✓
ZIP Context / Export        ████████████████████  ✓
Explain Search              ████████████████████  ✓
Time Travel                 ████████████████████  ✓
Live Token Streaming        ███████░░░░░░░░░░░░░  next
Realtime Neural Events      █████░░░░░░░░░░░░░░░  next
Automatic Agent Routing     ████░░░░░░░░░░░░░░░░  future
```

---

# 🚀 Roadmap técnico recomendado

```mermaid
timeline
    title Evolução da Cognitive Platform
    section Agora
      Shared multi-agent memory : Cognitive Console : Web Chat : Agent/MCP Registry
    section Próximo
      SSE / token streaming : Realtime Neural Brain : Memory pipeline diagnostics
    section Evolução
      Automatic agent routing : Cost/latency/quality policies : MCP runtime execution
    section Escala
      Multi-tenant isolation : Object Storage attachments : Distributed observability
```

### Próximos movimentos de maior impacto

- **SSE/WebSocket** para streaming real de tokens e eventos cognitivos;
- visualizar `Recall → Agent → Tool/MCP → Response → Capture` em tempo real;
- mostrar estados `captured → consolidating → indexed → retrievable`;
- roteamento automático de agente/modelo por custo, latência e qualidade;
- métricas de reutilização: quem criou a memória vs. quem realmente a consumiu;
- object storage para anexos;
- quotas e retenção;
- antivírus/AV scanning para uploads;
- RBAC e isolamento multi-tenant;
- OpenTelemetry para traces end-to-end;
- dashboard de custos por agente/modelo.

---

# 🤝 Relação com o projeto original

O backend mantém e estende o projeto open source **ai-memory**, de Fabio Akita / AkitaOnRails.

Projeto upstream:

```text
https://github.com/akitaonrails/ai-memory
```

O núcleo de memória, Wiki Markdown, hooks, MCP, consolidação e mecanismos centrais continuam sob a arquitetura do Core original.  
A **Cognitive Platform** adiciona a camada de produto: visualização, read-model PostgreSQL, registry, credenciais, Web Chat e observabilidade cognitiva.

Consulte também no backend:

```text
README.md
docs/ARCHITECTURE.md
docs/cognitive-console.md
docs/security.md
docs/deploy.md
```

---

# 📄 Licença

O AI Memory Core presente no backend declara licença **MIT**.  
Antes de distribuir uma versão derivada da plataforma, preserve os avisos de copyright e confirme a licença aplicável aos componentes adicionados pelo seu projeto.

---

<div align="center">

## 🧠 AI Memory

### O agente pode mudar. A memória do trabalho continua.

**Build once. Remember forever. Execute with any agent.**

</div>
