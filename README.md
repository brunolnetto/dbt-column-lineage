# dbt Column Lineage (Camada 1)

Traça a linhagem de uma coluna dbt e mostra como diagrama interativo
(mermaid ou Graphviz) num painel lateral, com sidebar em árvore e
clique-para-abrir-arquivo — motor: `column_lineage.py` bundlado em `scripts/`.

## Pré-requisitos

```
pip install -r scripts/requirements.txt
```

Projeto dbt com `manifest.json` (via `dbt compile`/`build`/`run`).

## Instalar

- **Via .vsix**: Command Palette → "Extensions: Install from VSIX..." → escolha `dbt-column-lineage.vsix`.
- **Modo dev**: abra a pasta no VS Code e F5 (não precisa `npm install`, `out/` já vem compilado).

## Uso

Command Palette → **"dbt Lineage: Trace Column"**. Se o editor ativo for um
`.sql` de model, o nome do model já vem resolvido via manifest (não é só o
nome do arquivo) e a coluna sugerida é a palavra sob o cursor.

O resultado aparece em dois lugares:
- **Painel lateral**: diagrama interativo, zoom, clique num nó abre o
  arquivo `.sql` correspondente
- **Sidebar "dbt Lineage"** (Explorer): a mesma árvore em texto, também
  clicável

## Configurações novas nesta camada

| Setting | Padrão | Descrição |
|---|---|---|
| `dbtLineage.diagramFormat` | `mermaid` | `mermaid` ou `dot` (Graphviz via WASM — melhor pra grafos largos) |

(demais settings — `manifestPath`, `catalogPath`, `pythonPath`, `scriptPath`, `dialect` — inalteradas desde a Camada 0)

## O que mudou desde a Camada 0

- Clique num nó do diagrama → abre o arquivo do model (`file_path` agora
  vem embutido em cada nó do JSON, calculado uma vez em Python)
- Suporte a `dot`/Graphviz via `@hpcc-js/wasm-graphviz`, alternativa ao mermaid
- Sidebar com `TreeDataProvider`, espelhando a árvore
- Detecção de model via manifest (não mais só nome do arquivo) + coluna
  sugerida pela palavra sob o cursor
- Empacotada como `.vsix` (`npx vsce package`)
- **Mudança de arquitetura**: a extensão agora chama o script só com
  `--format json` e constrói mermaid/dot ela mesma em TypeScript
  (`src/lineageGraph.ts`, porta testada do `build_graph`/`to_mermaid`/`to_dot`
  do Python) — isso é o que permite o clique-para-navegar sem gambiarra de
  escaping cruzando Python/JS

## Ainda não tem (Camada 2)

Sem bundle de runtime Python (precisa de `python3`+`sqlglot` instalados),
sem live-update ao salvar, sem hover/peek-definition.

## Testes

`npm run test:mermaid` continua validando sintaxe mermaid contra o bundle
real. O pipeline novo (`lineageGraph.ts` → mermaid.parse() real e →
`@hpcc-js/wasm-graphviz` real) foi validado com os mesmos fixtures antes
desta entrega — dedupe de diamond (4 nós, 4 arestas), diretivas de clique
presentes, SVG do Graphviz preservando o id original no `<title>` (é assim
que o clique acha o arquivo certo).
