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

[English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**Sachez ce qu'un fichier contient avant de lui faire confiance, de l'exécuter ou de le réimplémenter.** hexvero lit les exécutables, bundles d'applications, bases de données et captures sur votre machine **sans les exécuter**, puis montre ce qu'il a trouvé, avec quel niveau de confiance et ce qu'il n'a pas pu établir. Il réunit une CLI, un serveur MCP compact pour les agents de code et une interface web locale. Les analyseurs n'ont besoin que de Node.js.

## Installation

Node.js ≥ 22.12 requis. `npx hexvero` fonctionne sans installation ; `npm i -g hexvero` installe la commande `hexvero`.

## Ce qu'il lit

ELF, PE, Mach-O (y compris fat), Go buildinfo, assemblies .NET (métadonnées et corps CIL), WebAssembly, bytecode EVM, SQLite, plist, HAR, ZIP/ZIP64, APK (AXML, resources.arsc, DEX), JAR/classes Java, ASAR Electron, bundles JavaScript (webpack, Rspack, browserify, esbuild) avec source maps, bundles .app Apple avec métadonnées Objective-C et Swift, snapshots Flutter. Chaque résultat porte une confiance (`confirmed` ou `inferred`) et des limitations explicites.

<!-- unreleased-note:start -->

> **Note de version.** Cette page décrit `main`. npm sert la version du badge ; `recover`, `calls` et les autres nouveautés figurent sous _Unreleased_ dans le [changelog](CHANGELOG.md) et arrivent avec la prochaine version.

<!-- unreleased-note:end -->

## CLI

```bash
npx hexvero analyze ./program                 # résumé, constats, limitations
npx hexvero collection ./program imports      # paginer une liste
npx hexvero strings ./program --tag url       # chaînes étiquetées
npx hexvero recover ./bundle.js ./out         # découper un bundle en modules
npx hexvero calls ./program radare2 main      # graphe d'appels borné (avec radare2/rizin/Ghidra)
npx hexvero ui --open                         # interface web locale
npx hexvero setup --apply                     # enregistrer le serveur MCP
```

## Pour les agents IA

`hexvero mcp` expose 15 outils sur stdio avec un catalogue de moins de 32 Kio : ouvrir, analyser, paginer collections et chaînes, lire des octets, exporter, comparer, récupérer des sources et piloter des moteurs externes. `hexvero setup --apply` enregistre le serveur dans Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI et les autres clients détectés.

## Moteurs optionnels

radare2, rizin et Ghidra sont détectés sur le `PATH` ; hexvero ne les installe jamais. Avec l'un d'eux : désassemblage, décompilation, références croisées, appelants/appelés, graphe d'appels et recherche, le tout borné et mis en cache.

La documentation complète est en anglais : [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md).

## Licence

MIT.
