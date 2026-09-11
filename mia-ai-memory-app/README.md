# AI Memory Cognitive Console

Frontend React independente para observabilidade e configuração do AI Memory.

## Subir localmente

```bash
./script/run-local.sh
```

Por padrão o frontend usa `http://127.0.0.1:8787` como Cognitive API e sobe em `http://127.0.0.1:5173`.

Para apontar para outro backend:

```bash
COGNITIVE_API_URL=https://ai-memory-api.exemplo.com ./script/run-local.sh
```

## Configurar agentes e MCPs

Abra `Configurar Agentes` na navegação principal.

O módulo permite:

- cadastrar agentes por API key, MCP, modo híbrido ou integração externa;
- cadastrar MCPs Streamable HTTP, SSE e stdio;
- associar vários MCPs a um agente;
- cadastrar e reutilizar credenciais;
- rotacionar credenciais sem recuperar o valor anterior;
- ativar e desativar agentes e MCPs;
- correlacionar um agente cadastrado com sessões reais por `Identificador observado`.

Valores secretos nunca são exibidos novamente pelo frontend. O backend retorna somente versões mascaradas.
