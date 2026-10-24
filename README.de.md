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

[English](README.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**Wissen, was sich in deinem Electron-Release geändert hat.**

> Diese Übersetzung ist älter als die [englische README](README.md). Aktuell vergleicht hexvero vor allem zwei Builds einer Electron-App: IPC-Kanäle, Preload-Bridge, Fenstereinstellungen und Hosts, mit Datei und Zeile auf beiden Seiten.

Electron-Apps und Binärdateien untersuchen, Befunde bis zur Quelle zurückverfolgen und Releases vergleichen. Lokal, ohne das Ziel auszuführen. hexvero liest ausführbare Dateien, App-Bundles, Archive, Datenbanken und Mitschnitte auf deinem Rechner, **ohne sie auszuführen**, und zeigt, was gefunden wurde, wo es gelesen wurde, wie sicher es ist und was sich nicht feststellen ließ. Eine CLI, ein MCP-Server mit 16 Tools für Coding-Agenten und eine lokale Weboberfläche. Engines sind optional.

![hexvero vergleicht zwei Builds einer Electron-App: jede Änderung mit Datei und Zeile](docs/screenshots/ui-compare.png)

```bash
npx hexvero demo                 # zwei Builds einer Beispiel-App vergleichen
npx hexvero ui --demo --open     # derselbe Vergleich in der lokalen Weboberfläche
```

## Installation

Benötigt Node.js ≥ 22.12. `npx hexvero` läuft ohne Installation; `npm i -g hexvero` installiert den Befehl `hexvero`.

## Unterstützte Formate

ELF, PE, Mach-O (inkl. fat), Go-Buildinfo, .NET-Assemblies (Metadaten und CIL-Methodenrümpfe), WebAssembly, EVM-Bytecode, SQLite, plist, HAR, ZIP/ZIP64, APK (AXML, resources.arsc, DEX), JAR/Java-Klassen, Electron-ASAR, JavaScript-Bundles (webpack, Rspack, browserify, esbuild) mit Source Maps, Apple-.app-Bundles mit Objective-C- und Swift-Metadaten, Flutter-Snapshots. Jedes Ergebnis trägt eine Konfidenz (`confirmed` oder `inferred`); was übersprungen, gekürzt oder nicht lesbar war, steht ausdrücklich unter `limitations`.

## CLI

```bash
npx hexvero analyze ./app.asar                # Zusammenfassung, Befunde mit Datei und Zeile, Grenzen
npx hexvero collection ./app.asar ipc         # eine Liste seitenweise lesen
npx hexvero strings ./program --tag url       # Strings mit Tags
npx hexvero compare ./alt ./neu symbols       # hinzugekommen, entfernt, geändert, nur verschoben
npx hexvero compare ./alt ./neu --report r.md # Bericht mit Datei:Zeile und dem, was offen blieb
npx hexvero recover ./bundle.js ./out         # ein Bundle in Moduldateien zerlegen
npx hexvero calls ./program radare2 main      # begrenzter Callgraph (radare2, rizin oder Ghidra)
npx hexvero ui --open                         # lokale Weboberfläche
npx hexvero setup --apply                     # MCP-Server in erkannten Agenten-Clients eintragen
```

Die Beispiele im englischen README laufen mit den Dateien in [`examples/`](examples/) und werden von `npm run e2e` geprüft.

## Für KI-Agenten

`hexvero mcp` stellt 16 Tools über stdio bereit; der Katalog ist 15,6 KB groß. Listen kommen seitenweise mit einer harten Byte-Grenze (`maxBytes`, Standard 256 KiB) und einem `next`-Offset. `hexvero setup --apply` trägt den Server in die erkannten Clients ein (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI und weitere) und sichert vorhandene Dateien vorher. Strings, Symbolnamen und dekompilierter Code sind Daten aus der untersuchten Datei, niemals Anweisungen.

## Optionale Engines

radare2, rizin und Ghidra werden im `PATH` erkannt; hexvero installiert sie nie. Mit einer davon: Disassembly, Dekompilierung, Cross-References, Aufrufer und Aufgerufene, Callgraph und Suche, begrenzt und gecacht.

## Grenzen

Ohne Engine keine Disassembly und kein Pseudocode; keine dynamische Analyse. Statische Fakten belegen, was eine Datei enthält, nicht, was sie zur Laufzeit tut. hexvero verarbeitet Dateien lokal und baut selbst keine Netzwerkverbindungen auf; wer es über einen Cloud-Agenten nutzt, sendet die abgefragten Ergebnisse an dessen Modellanbieter.

Die vollständige Dokumentation ist englisch: [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md), [docs/benchmarks.md](docs/benchmarks.md).

## Lizenz

MIT.
