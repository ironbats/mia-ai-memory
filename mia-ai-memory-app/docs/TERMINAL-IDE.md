# Terminal IDE: shell interativo e UX inspirada no VS Code

Base: `ironbats/mia-ai-memory`, main `aa64f056a960ae6d87cf5f2f6e416c0e3a0448f6` (conferida novamente em 01/10/2026). Esta entrega é cumulativa e inclui o primeiro incremento de terminal.

## Modos de execução

### HOST RW · PTY

Com o Workspace Runtime atualizado e `node-pty` disponível, o terminal usa `@xterm/xterm`, o emulador de terminal da mesma família tecnológica usada pelo VS Code. Cada aba possui seu próprio shell persistente: `cd`, variáveis de ambiente, histórico e processos ficam independentes entre abas. A entrada é enviada ao PTY, com ANSI, cursor, teclado e tamanho real do terminal.

Há abas, divisão em dois terminais, busca na saída, limpar, renomear, interromper com Ctrl+C, encerrar/reiniciar shell, reconexão e maximizar/restaurar o painel. Fechar o painel não equivale a encerrar o shell. O título do diretório identifica o diretório inicial; não há integração de shell para acompanhar automaticamente o cwd depois de `cd`.

O shell inicial é Bash (ou `sh`) no Linux, Zsh/Bash no macOS e PowerShell (ou cmd) no Windows. A API não aceita executável ou argumentos arbitrários para escolher outro shell. Histórico e recursos de edição de linha vêm do próprio shell.

### HOST RW · comandos

Se o runtime não disponibiliza o módulo nativo `node-pty`, a IDE utiliza o terminal alternativo: até oito abas, histórico Up/Down, saída, stop, limpar e quebra de linha. O prompt do projeto aparece na mesma área rolável que a saída, imediatamente após o último resultado, sem barra de digitação separada. Ao abrir ou selecionar o terminal, a entrada recebe o foco; `Enter` executa o comando e `Ctrl+L` limpa a saída. O diretório ativo é indicado pelo prompt. Não recebe stdin durante processos em execução, cada comando abre outro processo e o cwd permanece compartilhado entre as abas deste modo. O fallback não simula PTY. Passe para o modo PTY para executar programas interativos e manter estados do shell independentes entre abas.

### Browser · limitado

Projetos sem runtime continuam com os comandos locais limitados, listados por `help`, usando a mesma disposição integrada do prompt e da saída. Não executam um shell do sistema.

## Atalhos no PTY

- `` Ctrl+` `` abre o painel pela IDE; `Ctrl+J` alterna o painel
- `` Ctrl+Shift+` `` abre outra aba
- `Ctrl+PageUp/PageDown` alterna as abas; setas navegam quando o foco está nas abas
- `Ctrl+C` interrompe o processo em primeiro plano; com texto selecionado, preserva a cópia
- `Ctrl+Shift+C` copia a seleção por ação explícita; `Ctrl+V` usa a colagem normal do navegador/xterm
- `Ctrl+F` busca na saída; Enter/Shift+Enter avançam/voltam, Esc fecha a busca
- `Ctrl+Shift+K` limpa a saída visível; `Ctrl+L` mantém a ação nativa do shell
- F2 com foco na aba, duplo clique ou botão de renomear altera o nome

Os nomes de abas, a seleção ativa e a divisão são estado da interface: reconstruir a interface/alternar projeto recupera os shells e sua saída retida, mas não é uma persistência completa da disposição visual do VS Code. Restrições do navegador/plataforma podem reservar alguns atalhos.

## Instalar e executar

Na raiz do checkout, use Node.js 22.12+ na linha 22 ou 24+ para o frontend (testado em Node 24). O runtime mantém seus próprios requisitos:

```sh
cd mia-ai-memory/services/workspace-runtime
npm ci --include=optional
npm run check
npm test
# Depois de parar o runtime que já estiver ativo:
npm start
```

Ou instale as dependências e reinicie usando `mia-ai-memory/script/workspace-runtime.sh restart` no fluxo existente. Esse script avisa quando o PTY nativo não está disponível, sem instalar dependências automaticamente. Não execute dois runtimes na mesma porta.

Em outro terminal:

```sh
cd mia-ai-memory-app
npm run deps:ensure
npm test
npm run build
npm run dev
```

Os comandos `npm run dev/build/preview` e `script/run-local.sh` agora verificam as
dependências reais antes de executar Vite. A existência do binário Vite, sozinha,
não comprova que os novos pacotes xterm foram instalados. Se a árvore estiver incompleta,
o bootstrap usa o lockfile para repará-la; se já estiver íntegra, não acessa a rede.
Leia [o README](../README.md) para diagnóstico e recuperação de instalações antigas.

Selecione um projeto conectado ao HOST RW e abra Terminal. O runtime anuncia `pty: true` em `/healthz` quando o módulo nativo carregou. Não é preciso migrar dados do AI Memory ou alterar configuração dos agentes.

`node-pty` é uma dependência nativa opcional: se a instalação não conseguir compilar/carregar o módulo, o runtime continua em modo comandos. Linux pode exigir compilador C/C++, make e Python; macOS pode exigir Xcode Command Line Tools; Windows pode exigir ferramentas de compilação C++/SDK compatíveis. Consulte as instruções oficiais de [node-pty](https://github.com/microsoft/node-pty#dependencies) para sua plataforma. Não copie `node_modules` desta entrega entre sistemas. Se aparecer `HOST RW · comandos` no terminal, verifique a instalação de `node-pty` no runtime e reinicie o serviço. O tooltip da barra de modo explica a capacidade indisponível; a IDE não afirma que o fallback é um shell interativo.

## Segurança e lifecycle

- As rotas PTY usam a mesma autenticação por token, política de origem e resolução de workspace das rotas existentes
- Toda leitura, stdin, resize e encerramento verifica o vínculo da sessão ao workspace; um ID de sessão de outro workspace retorna 404
- HOST RW executa com as permissões do usuário do runtime. **Não é sandbox:** o shell pode acessar arquivos fora da pasta inicial quando o usuário do sistema tem acesso. Não exponha esse runtime à internet, não rode como administrador e não trate projetos como fronteiras de isolamento do sistema operacional
- POST de criação recebe `clientId` para impedir duplicação de shell ao repetir uma criação de resultado incerto
- Entrada incerta nunca é reenviada automaticamente. O usuário recebe um aviso para conferir o shell antes de repetir
- A UI não grava comandos ou saída em localStorage. O histórico nativo do shell segue a configuração do usuário e pode gravar no disco; isto é diferente do histórico em memória do modo Browser/comandos
- Limites PTY: oito sessões por workspace, 64 no runtime, 1 MiB UTF-8 de saída por sessão, 64 KiB UTF-8 por entrada e dimensões de 2–500 colunas / 1–300 linhas. A UI mantém até 512.000 unidades UTF-16 de replay e 5.000 linhas de scrollback por emulador; a fila de stdin é limitada a 64 KiB. Reconectar recupera apenas o trecho ainda retido. Replay de saída não é uma fotografia do estado completo de um aplicativo TUI depois de truncamento
- Fechar/recarregar a página deixa o shell elegível para reconexão no mesmo runtime. Sessões sem leitura/entrada expiram após 30 minutos; sessões encerradas ficam disponíveis por até 5 minutos
- Encerrar uma aba solicita término do shell e processos descendentes comuns. Remover o workspace e desligar o runtime também solicitam cleanup. Processos intencionalmente daemonizados/reparentados exigem contenção do sistema operacional
- Reiniciar o runtime perde as sessões PTY; a UI indica sessão perdida e permite abrir outro shell
- A interface não habilita acesso automático ao clipboard por sequências OSC 52 nem abertura automática de links

## Protocolo

Todas as rotas estão sob `/api/v1/runtime/workspaces/:workspaceId/terminal/pty`:

- `GET /`: lista metadados das sessões do workspace
- `POST /`: cria sessão com `{ cols, rows, clientId }`
- `GET /:id?cursor=N&waitMs=20000`: long-poll cancelável, saída ANSI e cursor absoluto
- `POST /:id/input`: `{ data }`, sem replay automático
- `POST /:id/resize`: `{ cols, rows }`
- `DELETE /:id`: encerra e remove a sessão

Respostas de criação/leitura retornam `{ session }`. Cursors usam unidades UTF-16 absolutas; `startCursor`, `nextCursor` e `truncated` informam retenção parcial. List/input/resize não retransmitem o histórico completo. O cliente impõe deadline de 30 segundos para detectar conexões presas.

As rotas anteriores `/terminal/commands` e `/terminal/sessions/:id` continuam para compatibilidade. O modo comando preserva os ajustes de saída Unicode, cursores e encerramento do primeiro incremento.

## Validação

Os comandos reproduzíveis de teste estão acima. Os testes focados cobrem o transporte, o controller, lifecycle e o runtime; o relatório de entrega lista exatamente o que passou e quais verificações ficaram pendentes.

jsdom verifica DOM e eventos, mas não pintura, seleção real, IME ou layout. Build não substitui validação visual. Antes de publicar, valide em navegador real e na plataforma-alvo:

1. Duas abas: `cd` e variável em uma não devem alterar a outra
2. REPL Python/Node, `read`, setas, Tab e Ctrl+C com/sem seleção
3. Cores ANSI, saída Unicode e resize/maximizar/restaurar, inclusive com TUI
4. Ocultar/reabrir o painel, trocar projetos durante criação e durante execução
5. Recarregar a página, queda/retorno de rede, reinício do runtime e sessão expirada
6. Encerrar/reiniciar aba com processo ativo; remover workspace e desligar runtime
7. Busca na saída, renomeação, navegação por teclado, telas menores e clipboard
8. Editor/chat, autenticação e isolamento das rotas de workspace

O smoke Browser anterior (`npm run test:browser`) continua disponível para o fallback de comandos. Não deve ser descrito como validação PTY ponta a ponta. Windows e macOS precisam de validação própria.

## Cores e prompt no modo de comandos (v2.0.0.19)

- O prompt do projeto (`projeto/caminho $`) é parte do fluxo de saída, não uma barra inferior independente. Continua acessível por teclado, mantém histórico, abas e ações de interrupção. A entrada fica temporariamente indisponível enquanto um comando não interativo executa.
- O Workspace Runtime preserva somente sequências ANSI SGR (cores/ênfase) na saída dos comandos; sequências de controle OSC/CSI que alterariam cursor, título ou clipboard são removidas no fallback. O navegador transforma SGR em elementos React com texto escapado, sem renderização de HTML remoto. O transcript do agente continua sem códigos ANSI.
- Em `git status`, arquivos *modificados e ainda não preparados para commit* e arquivos *não rastreados* aparecem em vermelho; arquivos *preparados para commit* aparecem em verde. `git diff` usa verde em linhas adicionadas e vermelho em removidas. O estágio real do Git é a fonte dessa informação; executar `git add <arquivo>` altera o status.
- Para comandos Git diretos (`git status`, `git diff`, `git log`, `git show`), o runtime força cores apenas na execução com pipes, sem alterar a configuração global do Git. Redirecionamentos explícitos são preservados sem forçar cores. Os demais comandos continuam livres para decidir se produzem cor; somente o shell PTY garante comportamento típico de um terminal TTY.
- O fallback continua limitado a um processo por comando: `python` interativo, `vim`, `top`, REPLs e leitura de stdin exigem o modo PTY. Não tente simular um PTY somente com estilos CSS.

### Verificação manual rápida

1. Abra um workspace `HOST RW`, selecione Terminal e confirme o prompt dentro da área rolável, sem campo separado no rodapé.
2. Rode `pwd`, `git status`, `git diff` e `cd <pasta>`; confirme o diretório exibido no prompt e a saída acumulada acima dele.
3. Modifique um arquivo rastreado, crie outro e execute `git status`; os caminhos não preparados devem ficar vermelhos. Execute `git add <arquivo>` e repita `git status`; o caminho preparado deve ficar verde.
4. Confirme histórico `↑/↓`, várias abas, `Ctrl+C`, `Ctrl+L`, atualização do projeto, seleção/cópia de texto, rolagem e projetos diferentes.
5. Instale `node-pty` com `npm ci --include=optional` e reinicie o runtime para validar também o shell interativo PTY.
