# MIA AI Memory IDE — melhorias de UX sobre v3.0.3

Base: os ZIPs de frontend e backend v3.0.3 fornecidos. Data: 13/09/2026.

## Aplicação do pacote

1. Faça uma cópia da versão atual do frontend.
2. Extraia o ZIP da solução **na raiz do frontend**, onde estão `package.json` e `src`. Mescle as pastas e substitua somente os arquivos de mesmo caminho. Os arquivos entregues são integrais.
3. Use as dependências já declaradas no projeto e execute `npm run build`.
4. Publique o frontend pelo procedimento que já é usado no ambiente. Não há migração, variável nova ou modificação do backend.

O pacote não contém `node_modules`, build, arquivos temporários, cenários de demonstração ou arquivos originais sem alteração. As dependências React 19.3.0, React DOM 19.3.0 e Vite 8.2.2 foram mantidas.

## Como usar

- **IDE e chat:** arraste a divisória central para definir a proporção. Ela tem uma alça visível. Duplo clique ou Enter restaura 50/50. A preferência é salva neste navegador.
- **Teclado nos divisores:** Tab coloca foco na divisória; setas ajustam, Shift aumenta o passo, Home/End alcançam os limites e Escape cancela um arraste em andamento.
- **Painéis internos:** também é possível redimensionar o explorador, a lista de conversas e a altura do painel inferior. Os limites acompanham o espaço disponível.
- **Visualizar:** concentra os modos Mais chat / Equilibrado / Mais IDE, a escala de fonte e os comandos de recolher ou restaurar painéis. Restaurar layout e escala redefine os controles da IDE e a divisão central; a lista de conversas mantém sua própria preferência.
- **Buscar no projeto:** use a aba Buscar no explorador ou Ctrl/Cmd+Shift+F. Busca literal, sensibilidade a maiúsculas, palavra inteira e filtro por trecho do caminho. Os resultados exibem arquivo, linha, coluna e trecho; clicar abre e seleciona a ocorrência.
- **Buscar/substituir no editor:** Ctrl/Cmd+F ou Ctrl/Cmd+H. Substitua uma ocorrência ou todas as encontradas; a gravação no disco continua dependendo de Salvar. No Chrome/Edge, as substituições usam a operação nativa de edição para preservar Desfazer.
- **Ir para linha:** Ctrl/Cmd+G ou clique na posição na barra inferior. Aceita `linha` e `linha:coluna`.
- **Arquivos:** Ctrl/Cmd+P aceita nome, caminho e `arquivo:linha:coluna`. Sem texto, prioriza arquivos recentes do projeto durante a sessão.
- **Navegação:** Alt+PageUp / Alt+PageDown alternam abas. No explorador, setas, Home e End navegam; esquerda/direita recolhem/expandem pastas. Clique no caminho acima do editor para revelar o arquivo na árvore.
- **Abas salvas:** a paleta oferece “Abas: Fechar arquivos salvos”. Abas com alterações não salvas permanecem abertas. O fechamento individual de uma aba alterada mantém o diálogo de descarte existente.
- **Conversas:** filtre pelo título ou agente na lista. “Conversas” recolhe/expande a lista; o botão de nova conversa continua disponível quando ela está recolhida.
- **Painéis:** Ctrl/Cmd+B alterna o explorador e Ctrl/Cmd+J alterna o painel inferior, com foco dentro da IDE. Os demais atalhos já existentes permanecem disponíveis.
- **Salvar:** Ctrl/Cmd+S salva o arquivo ativo dentro da IDE; Ctrl/Cmd+Shift+S salva todas as abas. Com a IDE aberta e foco no chat, Ctrl/Cmd+S salva todas as abas, como informa a ajuda do compositor.

## Diagnóstico da interface fornecida

O print mostra o editor e o chat competindo pela largura, com nomes truncados e múltiplos controles em linhas estreitas. A investigação do código encontrou:

1. Três proporções predefinidas por CSS, sem divisor central interativo.
2. Várias regras acumuladas de largura mínima, específicas por viewport e modo da IDE, capazes de sobrepor uma preferência de largura.
3. Redimensionamento interno com limites fixos, sem teclado e sem tratar cancelamento do ponteiro ou saída da janela.
4. Paleta e Quick Open já existentes, mas sem busca de conteúdo do projeto, busca/substituição no arquivo ou entrada direta de linha/coluna.
5. Ações da paleta memorizadas com dependências incompletas, podendo manter callbacks de um projeto anterior.
6. Listener global da IDE registrado mesmo quando sua coluna estava oculta.
7. Lista de conversas sem filtro ou opção de recolher, consumindo parte da largura do texto.
8. Controle de fechamento de aba dentro de um botão, sem foco independente por teclado.

## Drill-down comparativo com Zed

A comparação usa a documentação oficial consultada na data acima. As observações sobre a MIA vêm dos fontes anexados; a escolha de prioridades é uma avaliação de implementação. Esta entrega amplia a UX da aplicação web existente. Recursos nativos do Zed que dependem de serviços adicionais são explicitados abaixo.

| Área | Referência Zed | MIA v3.0.3 | Resultado desta entrega |
| --- | --- | --- | --- |
| Organização de projetos | Projetos e contexto em uma janela | Registro e alternância de pastas locais | Mantidos; verificada preservação das abas ao alternar |
| Distribuição da tela | Layouts de painéis e contexto preservado | Compact / Split / Wide rígidos | Proporção livre por arraste, atalhos nos divisores e persistência |
| Configuração visual | Preferências de layout e fontes | Zoom e botões espalhados | Menu Visualizar, restauração e controles de recolhimento |
| Árvore de arquivos | Navegação, revelação e operações | Árvore, filtro de caminhos, criação e fixação de contexto | Navegação por setas e revelação pelo caminho do arquivo |
| Paleta | Busca e execução de ações | Paleta básica existente | Novas ações; callbacks atuais; lista vazia explícita e foco contido |
| Abrir arquivo | Finder por nome/caminho | Busca aproximada de caminhos | Recentes por projeto e entrada de linha/coluna |
| Buscar texto no projeto | Busca transversal e navegação | Apenas filtro por caminho | Busca local de conteúdo, trechos, filtros, cancelamento e navegação |
| Buscar/substituir arquivo | Ferramentas de edição | Ausentes no editor local | Busca literal, palavra inteira, Aa, anterior/próximo, substituição individual e total |
| Posição no arquivo | Navegação rápida | Barra de posição informativa | Diálogo linha:coluna com validação |
| Abas | Alternância rápida e gestão de arquivos | Clique e fechamento individual | Atalhos entre abas, botão de fechar acessível, fechamento de salvos |
| Símbolos/outline | Símbolos fornecidos pelo serviço de linguagem | Análise estrutural local | Mantida, com painel redimensionável e navegação de linha preservada |
| Diagnósticos | Integração com language servers | Diagnósticos estruturais locais | Mantidos; não apresentados como compilação/LSP completo |
| Completar código | Language servers e previsão de edição | Sugestões locais por Ctrl+Space | Mantidas, sem trocar o motor do editor |
| Conversas/agentes | Painel e histórico de agentes | Chat com agentes, contexto e memória | Histórico filtrável, lista ajustável/recolhível, texto adaptativo |
| Mudanças de código | Revisão integrada | Planos de alteração, conflitos, auto apply e diff de sessão | Mantidos; o pacote não muda contratos nem aplicação dos planos |
| Terminal | Shells e processos nativos | Comandos restritos do workspace no navegador | Mantido; ganha ajuste de altura acessível, sem simular shell nativo |
| Git | Operações e integrações de repositório | Detecção de branch/HEAD e diff da sessão | Mantidos; não adiciona commit/push ou execução de Git |
| Multibuffers, múltiplos cursores e LSP completo | Integração com motor/serviços do editor | Editor baseado em textarea com análise local | Exigem uma evolução própria do motor; não foram substituídos por controles sem implementação |
| Debugger, tasks, SSH e extensões | Integrações nativas | Sem transporte equivalente nesta interface | Dependem de execução/serviços próprios; fora da mudança de UX local |

Fontes oficiais:

- [Finding & Navigating](https://zed.dev/docs/finding-navigating): paleta, arquivos, busca e atalhos de navegação.
- [Command Palette](https://zed.dev/docs/command-palette): descoberta e execução de ações.
- [Project Panel](https://zed.dev/docs/project-panel): árvore, teclado e revelação do arquivo.
- [Windows & Projects](https://zed.dev/docs/windows-and-projects): organização de projetos e layouts.
- [All Settings](https://zed.dev/docs/reference/all-settings): preferências de fontes e painéis.
- [Editing Code](https://zed.dev/docs/editing-code): motor de edição e integração com serviços de linguagem.
- [Agent Panel](https://zed.dev/docs/ai/agent-panel): conversas, seleção de agente e contexto.
- [Terminal](https://zed.dev/docs/terminal): capacidades do terminal nativo.

## Organização e diff lógico por arquivo

| Arquivo | Tipo | O que mudou | Por que |
| --- | --- | --- | --- |
| `src/App.jsx` | Alterado | Integra hook de layout e divisor IDE/chat; passa visibilidade à IDE | Substituir proporções rígidas e evitar atalhos da IDE oculta |
| `src/main.jsx` | Alterado | Importa a folha de estilos das melhorias após os temas existentes | Garantir composição previsível dos estilos |
| `src/components/CodeWorkspace.jsx` | Alterado | Integra busca, navegação, divisores, menu de visualização, recentes, atalhos, foco e abas acessíveis; atualiza ações da paleta a cada render | Centralizar os recursos novos usando as operações existentes do workspace |
| `src/components/ChatWorkspace.jsx` | Alterado | Adiciona filtro, recolhimento e divisor da lista; adapta o layout à largura efetiva | Reservar mais espaço para a conversa sem perder os controles existentes |
| `src/components/SyntaxEditor.jsx` | Alterado | Integra busca/substituição, seleção de ocorrências, navegação por coluna e edição nativa para substituições | Editar e encontrar conteúdo diretamente no editor, com suporte a Desfazer |
| `src/components/IdeWorkbenchPanel.jsx` | Alterado | Recebe o divisor compartilhado no painel inferior | Reutilizar redimensionamento acessível e limpeza dos eventos |
| `src/components/IdeDialog.jsx` | Alterado | Usa gerenciamento de foco e permite retorno ao elemento anterior | Navegar pelo teclado sem escapar do diálogo |
| `src/components/layout/ResizeHandle.jsx` | Criado | Divisor com captura de ponteiro, limites, setas, Home/End, Shift, Enter, duplo clique, Escape e limpeza | Isolar o comportamento comum a quatro divisórias |
| `src/components/ide/ProjectSearch.jsx` | Criado | Interface de busca com filtros, leitura cancelável, progresso, resultados e erros de leitura | Encontrar conteúdo local sem modificar arquivos ou enviar texto à API |
| `src/components/ide/EditorFindBar.jsx` | Criado | Barra de busca/substituição com contagem e navegação de ocorrências | Separar os controles da lógica de renderização do editor |
| `src/components/ide/IdeViewOptions.jsx` | Criado | Menu com proporções, zoom, recolhimento e restauração | Simplificar a configuração e reduzir controles dispersos |
| `src/hooks/useWorkspaceLayout.js` | Criado | Controla proporção persistente, presets e limites conforme o espaço | Manter as duas áreas utilizáveis ao redimensionar |
| `src/hooks/useElementSize.js` | Criado | Observa largura e altura reais com ResizeObserver | Adaptar painéis ao container, inclusive durante arrastes |
| `src/hooks/useStoredPreference.js` | Criado | Persiste preferências tipadas com debounce e pagehide; tolera storage indisponível | Evitar falhas de abertura e excesso de gravações durante arrastes |
| `src/hooks/useDialogFocus.js` | Criado | Foco inicial, contenção de Tab e restauração ao fechar | Reutilizar comportamento de foco nos diálogos e paletas |
| `src/lib/ideSearch.js` | Criado | Busca literal Unicode, palavra inteira, offsets e busca assíncrona com limites | Separar processamento de texto da interface e controlar custo de leitura |
| `src/styles/workspace-ux.css` | Criado | Estilos isolados para divisão, busca, abas, menus e responsividade | Resolver conflitos de larguras antigas sem reescrever os temas |
| `docs/MELHORIAS-UX-IDE.md` | Criado | Relatório, comparação, aplicação e limites da entrega | Tornar o pacote auditável e pronto para aplicar |

## Preservação e limites

- Nenhum fonte do backend, rota HTTP, código de autenticação, contrato de chat, regra de autorização de pasta, geração de ZIP, aplicação de plano ou persistência de projetos foi alterado.
- `useLocalWorkspace.js` e `api.js` permanecem idênticos aos originais. A busca usa `readPath`, a edição usa `updateContent` e a gravação usa `saveFile`/`saveAll` já existentes.
- A busca do projeto percorre somente os caminhos que o workspace já indexou (limite original: 5.000 arquivos), respeitando as exclusões originais de credenciais, `.git`, dependências e binários. A leitura por arquivo continua limitada a 2 MB pela API local existente.
- Para manter a interface responsiva, cada busca do projeto limita o trabalho a 300 ocorrências ou 32 MB estimados de texto; a interface informa quando é necessário refinar. Arquivos ilegíveis são informados separadamente. A busca não escreve arquivos nem faz chamadas de rede.
- No editor, a lista de ocorrências é limitada a 10.000. Ao ultrapassar, “Todas” é desabilitado e solicita refinar a busca, evitando substituição parcial apresentada como completa. O texto de substituição é literal, inclusive `$` e barras.
- Acima de 1.180 px de viewport, a IDE e o chat ficam lado a lado. Abaixo disso, ficam empilhados, e o divisor central é ocultado. Dentro de painéis estreitos, explorador/histórico migram para uma faixa superior que pode ser recolhida.
- Preferências de layout são locais ao navegador; arquivos recentes são mantidos por projeto durante a sessão. A entrega não altera a política original de persistência de abas/conteúdo não salvo entre recargas.
- Terminal, diagnósticos, outline e Git continuam tendo as capacidades locais originais. Não há promessa de paridade com um runtime nativo de IDE.
- A validação usa dados de demonstração, diretórios temporários do navegador e respostas simuladas das APIs. Autenticação de produção, serviços de agentes e integrações externas reais não foram executados neste ambiente.

## Verificação

- Build de produção com as dependências originais: aprovado (Vite 8.2.2).
- 78 verificações funcionais distintas no Chrome, usando perfil temporário, arquivos no armazenamento local do navegador e APIs simuladas: aprovadas, sem erros JavaScript observados.
- Larguras verificadas: 390, 820, 1.024, 1.181, 1.280, 1.440, 2.560 e 3.346 px. A revisão foi repetida com escala de IDE de 130%, incluindo visibilidade dos controles e área útil da árvore/editor.
- Comparação byte a byte: todos os arquivos do backend e os arquivos frontend `api.js`, `useLocalWorkspace.js`, `workspaceProjectRegistry.js`, `package.json`, `vite.config.js`, `nginx.conf` e `Dockerfile` preservados.
- Conferência visual de screenshots de desktop e celular realizada. Não foram criados testes unitários nem adicionados arquivos de testes ao pacote.

### Cenários funcionais conferidos

- Quick Open abre na linha e coluna solicitadas
- Arquivos protegidos e dependências continuam fora da árvore
- Divisores do IDE, explorador e chat visíveis
- Arrastar aumenta a proporção horizontal da IDE
- Preferência de divisão persistida
- Setas ajustam a divisão
- Home respeita o limite mínimo
- End respeita o limite máximo
- Enter restaura a divisão equilibrada
- Duplo clique restaura a divisão
- Escape cancela arraste e libera cursor
- Explorador redimensiona
- Lista de conversas redimensiona
- Filtro de conversas funciona
- Recolher conversas amplia chat
- Substituir edita o buffer
- Substituição marca alteração não salva
- Desfazer recupera substituição
- Substituir todas altera ocorrências sem gravar automaticamente
- Ir para linha rejeita posição inválida
- Ir para linha move cursor
- Busca no projeto encontra alteração ainda não salva
- Resultado de busca seleciona texto no editor
- Busca abre outro arquivo na ocorrência
- Atalho alterna abas
- Fechar aba alterada pede confirmação
- Cancelar fechamento preserva texto
- Fechar salvos mantém a aba alterada
- Salvar mantém fluxo de gravação local
- Painel inferior redimensiona verticalmente
- Paleta cria arquivo no projeto atual após troca
- Trocar projetos preserva alterações não salvas
- Atalho recolhe explorador
- Escape fecha paleta com foco em qualquer comando
- Escala de 130% aplicada
- Recarregar recupera proporção persistida
- IDE fechada não intercepta atalhos
- Nenhum erro JavaScript nos fluxos
