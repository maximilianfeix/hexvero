<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/banner-light.svg">
  <img src="docs/banner-dark.svg" alt="hexvero" width="100%">
</picture>

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![MCP tools](https://img.shields.io/badge/MCP_tools-15-F2B84B?style=flat-square&labelColor=1B1D21)](README.md#for-ai-agents)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · **Português (Brasil)** · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**Saiba o que um arquivo contém antes de confiar nele, executá-lo ou reimplementá-lo.** O hexvero lê executáveis, bundles de aplicativos, bancos de dados e capturas na sua máquina **sem executá-los** e mostra o que encontrou, com que confiança e o que não conseguiu determinar. Reúne uma CLI, um servidor MCP compacto para agentes de código e uma interface web local. Os analisadores precisam apenas do Node.js.

## Instalação

Requer Node.js ≥ 22.12. `npx hexvero` funciona sem instalar nada; `npm i -g hexvero` instala o comando `hexvero`.

## O que ele lê

ELF, PE, Mach-O (incl. fat), Go buildinfo, assemblies .NET (metadados e corpos CIL), WebAssembly, bytecode EVM, SQLite, plist, HAR, ZIP/ZIP64, APK (AXML, resources.arsc, DEX), JAR/classes Java, ASAR do Electron, bundles JavaScript (webpack, Rspack, browserify, esbuild) com source maps, bundles .app da Apple com metadados Objective-C e Swift, snapshots Flutter. Cada resultado traz uma confiança (`confirmed` ou `inferred`) e limitações explícitas.

<!-- unreleased-note:start -->

> **Nota de versão.** Esta página descreve `main`. O npm serve a versão do selo; `recover`, `calls` e outras novidades estão em _Unreleased_ no [changelog](CHANGELOG.md) e chegam com a próxima versão.

<!-- unreleased-note:end -->

## CLI

```bash
npx hexvero analyze ./program                 # resumo, achados, limitações
npx hexvero collection ./program imports      # paginar uma lista
npx hexvero strings ./program --tag url       # strings com etiqueta
npx hexvero recover ./bundle.js ./out         # dividir um bundle em módulos
npx hexvero calls ./program radare2 main      # grafo de chamadas limitado (com radare2/rizin/Ghidra)
npx hexvero ui --open                         # interface web local
npx hexvero setup --apply                     # registrar o servidor MCP
```

## Para agentes de IA

`hexvero mcp` serve 15 ferramentas por stdio com um catálogo menor que 32 KiB: abrir, analisar, paginar coleções e strings, ler bytes, exportar, comparar, recuperar fontes e acionar engines externas. `hexvero setup --apply` registra o servidor no Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI e outros clientes detectados.

## Engines opcionais

radare2, rizin e Ghidra são detectados no `PATH`; o hexvero nunca os instala. Com um deles: desmontagem, descompilação, referências cruzadas, chamadores/chamados, grafo de chamadas e busca, tudo limitado e em cache.

A documentação completa está em inglês: [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md).

## Licença

MIT.
