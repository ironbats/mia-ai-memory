# AI Memory Cognitive Console

Frontend React independente para observabilidade e configuração do AI Memory.

## Requisitos e inicialização segura

Use **npm** e Node.js **22.12+ na linha 22, ou 24+**. O bootstrap verifica o manifesto,
o lockfile, os pacotes instalados, os imports do xterm e os módulos nativos da ferramenta.
Se faltar algo ou uma versão não corresponder ao lock, executa `npm ci --include=dev
--include=optional --no-audit --no-fund` antes de iniciar. Uma árvore íntegra não reinstala
nada e pode iniciar offline. Uma instalação incompleta precisa dos pacotes no cache ou de
acesso ao registry; se falhar, o frontend não inicia até o problema ser resolvido.

O mesmo controle protege `npm run dev`, `npm run build`, `npm run preview` e o script
abaixo. Não use o executável Vite diretamente para contornar essa verificação.

## Subir localmente

```bash
./script/run-local.sh
```

O script usa `http://127.0.0.1:8787` como Cognitive API e sobe em
`http://127.0.0.1:5174`. Já `npm run dev` sem opções usa a porta 5173 do Vite.
Use `FRONTEND_PORT` no script, ou `-- --port 5174 --strictPort` no comando npm,
para escolher a porta. Se o ZIP não preservar permissão executável, execute
`bash script/run-local.sh`.

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

## Terminal da IDE

O modo HOST RW agora oferece shell interativo PTY com xterm.js quando o runtime
tem suas dependências instaladas. Abas independentes, busca, reconexão,
maximizar/restaurar painel, fallback de comandos e instalação estão documentados em
[docs/TERMINAL-IDE.md](docs/TERMINAL-IDE.md).

## Verificar dependências e validar

```bash
npm run deps:check   # Diagnóstico, sem instalar nem alterar o lock
npm run deps:ensure  # Repara a instalação se necessário
npm test
npm run build
npm run test:startup # Teste real isolado; pode baixar dependências
```

O teste de startup cria e remove somente uma pasta temporária própria. Cobre instalação
limpa, startup offline, Vite antigo sem xterm e recuperação de módulos nativos. Não inicia
nem altera backend, runtime, dados de projeto ou processos do usuário.

Para recuperar a versão anterior após o erro `Failed to resolve import "@xterm/xterm"`,
pare o frontend e, na pasta `mia-ai-memory-app`, execute:

```bash
npm ci --include=dev --include=optional --no-audit --no-fund
npm run dev -- --port 5174 --strictPort
```

Isso sincroniza somente a árvore de dependências conforme o lock. Mantenha
`package.json` e `package-lock.json` da mesma entrega. Não copie `node_modules`
entre máquinas nem desative o overlay do Vite para ocultar erros.

## Imagem Docker

O contexto de build é a pasta deste frontend:

```bash
docker build -t ai-memory-console .
```

O build usa o lockfile e não copia dependências locais, `dist` nem arquivos `.env`
para a imagem. O empacotamento Docker não foi executado no ambiente desta correção;
consulte o relatório para os limites de validação.
