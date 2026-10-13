# Editor da IDE — diagnósticos e menus de contexto

## Verificação de sintaxe

Abra um arquivo e use o botão **Verificar** do editor, `Ctrl+Shift+B`, ou clique
com o botão direito no código e escolha **Verificar sintaxe**. O painel **Problems**
exibe a origem da verificação e leva diretamente à linha e coluna do erro.
As linhas com erros também recebem indicadores no gutter e sublinhado no código.
A análise é executada automaticamente após o usuário parar de digitar.

A verificação real exige que o projeto esteja conectado em modo **HOST RW** ao
Workspace Runtime atualizado, usando a mesma configuração e autenticação já
utilizadas pelo terminal. O conteúdo não salvo é enviado apenas ao runtime local
para análise e não é gravado no filesystem. As ferramentas de linguagem precisam
estar instaladas na máquina que executa o runtime. Sem runtime, ou para uma
linguagem sem ferramenta configurada, o editor mantém a análise estrutural local,
mas apresenta o estado **não verificado** em vez de anunciar compilação aprovada.
O resultado é por arquivo e não substitui o build do projeto.

## Menu do clique direito

- **Código:** desfazer/refazer, operações sobre seleção, comentar, duplicar/apagar
  linha, navegar, formatar, verificar e salvar. Clipboard depende das permissões
  e da API de transferência do navegador; atalhos nativos continuam disponíveis.
- **Arquivos e pastas:** abrir, expandir/recolher, criar arquivo na pasta,
  copiar caminho, fixar/remover do contexto do agente, buscar e atualizar.
- **Abas:** ativar, salvar, copiar caminho e fechar. Fechamento com alterações
  não salvas mantém a confirmação já existente.
- **Área geral:** criar/abrir arquivo, buscar, diagnosticar, abrir Problems e
  Terminal, atualizar projeto.

O menu suporta Escape, setas, Home e End, fecha ao clicar fora e respeita o
ambiente visual existente. O menu nativo do terminal não é substituído.

## Implantação

1. Aplicar os arquivos de `frontend/` na raiz do frontend e os arquivos de
   `backend/` na raiz do backend, preservando as subpastas.
2. Reiniciar o Workspace Runtime local para expor a nova rota de diagnósticos.
3. Executar os comandos de instalação e build que já são utilizados pelo projeto.
4. Abrir um projeto HOST RW e verificar um arquivo com erro conhecido; testar os
   menus de contexto no editor, explorador e abas.
