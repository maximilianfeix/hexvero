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

[English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · **Русский** · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**Узнайте, что содержит файл, прежде чем доверять ему, запускать или воспроизводить.** hexvero читает исполняемые файлы, бандлы приложений, базы данных и дампы трафика на вашей машине **без их запуска** и показывает, что найдено, с какой уверенностью и что установить не удалось. В одном пакете: CLI, компактный MCP-сервер для кодовых агентов и локальный веб-интерфейс. Парсерам нужен только Node.js.

## Установка

Требуется Node.js ≥ 22.12. `npx hexvero` работает без установки; `npm i -g hexvero` ставит команду `hexvero`.

## Что читает

ELF, PE, Mach-O (включая fat), Go buildinfo, сборки .NET (метаданные и тела CIL), WebAssembly, байткод EVM, SQLite, plist, HAR, ZIP/ZIP64, APK (AXML, resources.arsc, DEX), JAR/классы Java, ASAR Electron, JavaScript-бандлы (webpack, Rspack, browserify, esbuild) с source maps, .app-бандлы Apple с метаданными Objective-C и Swift, снапшоты Flutter. Каждый результат имеет уровень уверенности (`confirmed` или `inferred`) и явный список ограничений.

## CLI

```bash
npx hexvero analyze ./program                 # сводка, находки, ограничения
npx hexvero collection ./program imports      # постраничный вывод списка
npx hexvero strings ./program --tag url       # строки с метками
npx hexvero recover ./bundle.js ./out         # разбить бандл на модули
npx hexvero calls ./program radare2 main      # ограниченный граф вызовов (с radare2/rizin/Ghidra)
npx hexvero ui --open                         # локальный веб-интерфейс
npx hexvero setup --apply                     # зарегистрировать MCP-сервер
```

## Для ИИ-агентов

`hexvero mcp` отдаёт 15 инструментов по stdio с каталогом меньше 32 КиБ: открыть, проанализировать, листать коллекции и строки, читать байты, экспортировать, сравнивать, восстанавливать исходники и управлять внешними движками. `hexvero setup --apply` регистрирует сервер в Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI и других обнаруженных клиентах.

## Необязательные движки

radare2, rizin и Ghidra обнаруживаются в `PATH`; hexvero никогда их не устанавливает. С одним из них доступны дизассемблирование, декомпиляция, перекрёстные ссылки, вызывающие/вызываемые функции, граф вызовов и поиск, всё с ограничениями и кэшем.

Полная документация на английском: [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md).

## Лицензия

MIT.
