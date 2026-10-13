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

[English](README.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**Descubre qué contiene un archivo antes de confiar en él, ejecutarlo o reimplementarlo.** hexvero lee ejecutables, bundles de aplicaciones, bases de datos y capturas en tu máquina **sin ejecutarlos** y muestra lo que encontró, con qué confianza y qué no pudo determinar. Incluye una CLI, un servidor MCP compacto para agentes de código y una interfaz web local. Los analizadores sólo necesitan Node.js.

## Instalación

Requiere Node.js ≥ 22.12. `npx hexvero` funciona sin instalar nada; `npm i -g hexvero` instala el comando `hexvero`.

## Qué lee

ELF, PE, Mach-O (incl. fat), Go buildinfo, ensamblados .NET (metadatos y cuerpos CIL), WebAssembly, bytecode EVM, SQLite, plist, HAR, ZIP/ZIP64, APK (AXML, resources.arsc, DEX), JAR/clases Java, ASAR de Electron, bundles JavaScript (webpack, Rspack, browserify, esbuild) con source maps, bundles .app de Apple con metadatos Objective-C y Swift, snapshots de Flutter. Cada resultado indica su confianza (`confirmed` o `inferred`) y lista limitaciones explícitas.

<!-- unreleased-note:start -->

> **Nota de versión.** Esta página describe `main`. npm sirve la versión del distintivo; `recover`, `calls` y otras novedades figuran en _Unreleased_ del [changelog](CHANGELOG.md) y llegan con la próxima versión.

<!-- unreleased-note:end -->

## CLI

```bash
npx hexvero analyze ./program                 # resumen, hallazgos, limitaciones
npx hexvero collection ./program imports      # paginar una lista
npx hexvero strings ./program --tag url       # cadenas con etiqueta
npx hexvero recover ./bundle.js ./out         # dividir un bundle en módulos
npx hexvero calls ./program radare2 main      # grafo de llamadas acotado (con radare2/rizin/Ghidra)
npx hexvero ui --open                         # interfaz web local
npx hexvero setup --apply                     # registrar el servidor MCP
```

## Para agentes de IA

`hexvero mcp` sirve 15 herramientas sobre stdio con un catálogo menor de 32 KiB: abrir, analizar, paginar colecciones y cadenas, leer bytes, exportar, comparar, recuperar fuentes, y ejecutar motores externos. `hexvero setup --apply` registra el servidor en Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI y otros clientes detectados.

## Motores opcionales

radare2, rizin y Ghidra se detectan en `PATH`; hexvero nunca los instala. Con uno de ellos: desensamblado, descompilación, referencias cruzadas, llamadores/llamados, grafo de llamadas y búsqueda, todo acotado y en caché.

La documentación completa está en inglés: [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md).

## Licencia

MIT.
