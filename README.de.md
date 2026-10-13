<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/banner-light.svg">
  <img src="docs/banner-dark.svg" alt="hexvero – Reverse Engineering für alles, lokal. Fakten mit Belegen, transparent über die Grenzen der Analyse." width="100%">
</picture>

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maximilianfeix/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://github.com/maximilianfeix/hexvero/releases/latest)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![Runtime dependencies](https://img.shields.io/badge/core_dependencies-0-F2B84B?style=flat-square&labelColor=1B1D21)](packages/core/package.json)
[![MCP tools](https://img.shields.io/badge/MCP_tools-15-F2B84B?style=flat-square&labelColor=1B1D21)](#for-ai-agents)
[![Network](https://img.shields.io/badge/network-never-F2B84B?style=flat-square&labelColor=1B1D21)](#faq)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

<a href="#install"><img src="https://img.shields.io/badge/Install-F2B84B?style=for-the-badge&labelColor=1B1D21" alt="Install"></a>
<a href="#web-ui"><img src="https://img.shields.io/badge/Web_UI-1B1D21?style=for-the-badge" alt="Web UI"></a>
<a href="#for-ai-agents"><img src="https://img.shields.io/badge/MCP_server-1B1D21?style=for-the-badge" alt="MCP server for AI agents"></a>
<a href="#what-it-reads"><img src="https://img.shields.io/badge/17_formats-1B1D21?style=for-the-badge" alt="17 formats"></a>

[English](README.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[Installation](#install) · [Unterstützte Formate](#what-it-reads) · [CLI](#cli) · [Weboberfläche](#web-ui) · [Für KI-Agenten](#for-ai-agents) · [Engines](#optional-engines) · [Vergleich mit REA](#compared-with-rea) · [Funktionsweise](#how-it-works) · [FAQ](#faq)

</div>

---

**Erkennen Sie, was eine Datei enthält, bevor Sie ihr vertrauen, sie ausführen oder nachbauen.** hexvero liest ausführbare Dateien, App-Bundles, Datenbanken und Mitschnitte auf Ihrem Rechner, **ohne sie auszuführen**, und zeigt, was gefunden wurde, wie sicher die Ergebnisse sind und was sich nicht feststellen ließ. Es vereint eine CLI, einen kompakten MCP-Server für Coding-Agenten und eine lokale Weboberfläche. Die zugrunde liegenden Parser benötigen nur Node.js.

```bash
npx hexvero analyze /Applications/Notion.app/Contents/Resources/app.asar
npx hexvero ui --open          # drag any file into the browser
npx hexvero setup --apply      # register the MCP server with Claude Code, Cursor, Codex …
```

```text
/opt/homebrew/bin/gh
  macho · 51 MB · sha256 91c6ac70187c39ed… · 90 ms

Summary
  Mach-O arm64 executable, 4 dylibs, 144 symbols · Go 1.25.1 (github.com/cli/cli/v2/cmd/gh)

Findings
  ○ Imports ptrace/sysctl (possible anti-debugging)
  ● cgo enabled (links C code)

Collections
  segments (5), sections (15), symbols (144), imports (144), libraries (4), goDependencies (212)
```

Ein ausgefüllter Punkt kennzeichnet eine Tatsache, die der Parser aus der Datei gelesen hat; ein nicht ausgefüllter Punkt kennzeichnet eine aus Mustern abgeleitete Schlussfolgerung. Alles, was sich nicht feststellen ließ, wird aufgeführt und niemals verborgen.

### Warum hexvero?

Es gibt bereits Reverse-Engineering-Werkzeuge für Agenten. Sie bringen jedoch über 100 MCP-Tools und einen mehrere Megabyte großen Katalog mit, der Modelle mit kleinem Kontextfenster überfordert. Ihre Ergebnisse sind so groß, dass Node der Arbeitsspeicher ausgeht, und vor der ersten brauchbaren Antwort müssen Ghidra, Hopper oder IDA installiert werden. hexvero verfolgt einen anderen Ansatz:

- **Integriert, ohne Abhängigkeiten.** ELF, PE, Mach-O, Go, .NET, WebAssembly, EVM, SQLite, plist, APK, Electron, JavaScript, Source Maps und HAR werden durch Code in diesem Repository geparst. Kein JDK, kein Python, keine Engine.
- **Bewusst begrenzte Ausgaben.** Jede Liste wird seitenweise mit `offset`, `limit`, einem Textfilter und einem Byte-Budget ausgegeben. Das vollständige Ergebnis landet mit einem einzigen Befehl in einer Datei, niemals im Kontextfenster.
- **15 Tools statt 139.** Der MCP-Katalog ist kleiner als 32 KiB und folgt einem Arbeitsablauf: öffnen, analysieren, seitenweise abrufen, Bytes lesen, exportieren.
- **Transparente Ergebnisse.** Befunde sind mit `confirmed` oder `inferred` gekennzeichnet; `limitations` gibt an, was übersprungen, gekürzt oder nicht lesbar war und warum.
- **Eine vollwertige Oberfläche.** Gesamtbewertung, Kennzeichnungen für Schutzmaßnahmen, Befunde, virtualisierte Tabellen, ein Hex-Viewer mit Live-Dekodierung und ein Modulgraph für Electron-Apps. Ausschließlich lokal.
- **Engines bei Bedarf.** radare2, rizin und Ghidra lassen sich über eine einheitliche Schnittstelle für Disassemblierung und Dekompilierung einbinden; hexvero installiert sie niemals selbst.

<a id="install"></a>

## Installation

Erfordert Node.js 22.12 oder neuer (Version 24 wird für SQLite-Unterstützung ohne Warnungen empfohlen).

```bash
npm install -g hexvero        # the hexvero command
hexvero doctor                # checks Node, node:sqlite and optional engines
```

Alternativ ohne Installation ausführen: `npx hexvero <command>`.

<a id="what-it-reads"></a>

## Unterstützte Formate

| Analyseobjekt           | Integrierte Analyseergebnisse                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ELF (32/64, LE/BE)      | Sektionen, Segmente, Symbole, dynamische Importe/Exporte, benötigte Bibliotheken, RPATH, Build-ID, NX/PIE/RELRO/Canary/FORTIFY      |
| PE / PE32+              | Sektionen mit Entropie, Importe (Namen und Ordinalzahlen), Exporte und Weiterleitungen, PDB-Pfad, ASLR/NX/CFG/GS/Authenticode       |
| Mach-O (Thin und Fat)   | Ladebefehle, Segmente, Symbole, dylibs, UUID, Plattform/SDK, Verschlüsselung, Codesignatur, PIE/ARC/Canary                          |
| Go-Binärdateien         | Compilerversion, Hauptmodul, Abhängigkeiten mit Ersetzungen, Build-Einstellungen, VCS-Revision                                      |
| .NET-Assemblies         | Assembly und Referenzen, Typen mit Methoden, P/Invoke-Deklarationen, Benutzerzeichenfolgen, Hinweise auf Obfuskation                |
| WebAssembly             | Typen, Importe/Exporte mit korrekten Indexräumen, Speicher, Tabellen, Erzeuger, WASI/Emscripten/wasm-bindgen                        |
| EVM-Bytecode            | Disassemblierung unter Berücksichtigung von PUSH, Dispatch-Selektoren mit Sprungzielen, solc-Metadaten, DELEGATECALL/SELFDESTRUCT   |
| SQLite-Datenbanken      | Tabellen, Spalten, Zeilenanzahlen, Beispielzeilen, Views, Indizes, Trigger (nur lesend über `node:sqlite`)                          |
| plist (XML und binär)   | Vollständig dekodierte Property List                                                                                                |
| Android APK             | Manifestdaten, Berechtigungen, Komponenten mit Intent-Filtern, Deep Links, native Bibliotheken, DEX-Klassen und -Pakete, Frameworks |
| Java-Klasse / JAR / DEX | Konstantenpool, Klassenmember, referenzierte APIs, Manifest und Pakete; DEX-Klassen, Zeichenfolgen und SDK-Hinweise                 |
| Electron-ASAR / JS-Apps | Paketdaten, Modulrollen, aufgelöster Importgraph, Zuordnung von Sendern und Empfängern auf IPC-Kanälen, Preload- und Sandbox-Flags  |
| JavaScript-Dateien      | Importe, require-Aufrufe, dynamische Importe, Exporte, IPC-Nutzung, Source-Map-Kommentar                                            |
| Source Maps             | Nach Paket gruppierte Quelldateien, Anzahl der Zuordnungen, Ermittlung der ursprünglichen Position                                  |
| HAR-Mitschnitte         | Hosts, Methoden, Statusgruppen, API-ähnliche Endpunkte, Geheimnisse in URLs, Authentifizierungsheader, WebSockets                   |
| Beliebige Dateien       | Zeichenfolgen (ASCII und UTF-16) mit Tags, begrenzte Byte-Ausschnitte, Entropie                                                     |

<a id="cli"></a>

## CLI

```text
hexvero analyze <path> [--json] [--out file.json]     summary, findings, limitations, overview
hexvero collection <path> <name> [--text s] [--limit n] [--offset n]
hexvero strings <path> [--min n] [--utf16] [--tag url|path|email|ip|format|secret-ish]
hexvero bytes <path> <offset> [length]                hex dump
hexvero compare <a> <b> <collection> [--key field]    added / removed between two builds
hexvero export <path> <out.json>                      the complete analysis
hexvero provider <path> radare2|rizin|ghidra functions|disassemble|decompile|strings|imports [--address a]
hexvero mcp · hexvero ui [--port n] [--open] · hexvero doctor · hexvero setup [--client c] [--apply]
```

Jeder Befehl unterstützt `--json`. Exit-Codes: `0` erfolgreich, `1` Analyse fehlgeschlagen (mit strukturiertem Fehler), `2` Aufruffehler. Siehe [docs/cli.md](docs/cli.md).

<a id="web-ui"></a>

## Weboberfläche

```bash
hexvero ui --open
```

Startet einen Loopback-Server mit einem sitzungsspezifischen Token und öffnet den Browser. Ziehen Sie eine Datei an eine beliebige Stelle oder geben Sie einen Pfad auf Ihrem Rechner ein. Jedes Analyseobjekt erhält eine Gesamtbewertung, ein Datenblatt, Kennzeichnungen für Schutzmaßnahmen, Befunde mit Angabe der Sicherheit und einen Tab je tatsächlich vorhandener Sammlung. Der Hex-Viewer lädt Ausschnitte bei Bedarf, dekodiert das ausgewählte Byte als u8…u64/f32/f64 in beiden Byte-Reihenfolgen und lässt sich mit den Pfeiltasten bedienen. Electron-Apps erhalten einen in Ebenen gegliederten Modulgraphen, der bei einem Klick die Importe eines Moduls hervorhebt. Mit dunklem und hellem Design, Tastenkürzeln (`⌘O` zum Öffnen, `/` zum Filtern) und Smartphone-Layout.

<a id="for-ai-agents"></a>

## Für KI-Agenten

```bash
hexvero setup                 # shows what would change
hexvero setup --apply         # writes the MCP registration, backs up existing files
hexvero setup --client codex  # prints the TOML snippet for ~/.codex/config.toml
```

Unterstützt werden Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code und Codex. Jeder andere Client kann `npx -y hexvero mcp` über stdio ausführen.

| Tool                                         | Zweck                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hexvero_open`                               | Datei oder Verzeichnis registrieren; gibt eine aus dem Inhalt abgeleitete ID zurück                               |
| `hexvero_analyze`                            | Zusammenfassung, Befunde, Einschränkungen, Eintragszahlen der Sammlungen und eine kompakte Übersicht              |
| `hexvero_collection`                         | Beliebige Listen seitenweise abrufen: Symbole, Importe, Exporte, Sektionen, Typen, Selektoren, Anfragen, Module … |
| `hexvero_strings`                            | Zeichenfolgen mit Tags, Filter und seitenweisem Abruf                                                             |
| `hexvero_bytes`                              | Ein begrenzter Hex-Ausschnitt                                                                                     |
| `hexvero_export`                             | Vollständige Analyse in eine Datei exportieren                                                                    |
| `hexvero_compare`                            | Eine Sammlung zwischen zwei Analyseobjekten vergleichen                                                           |
| `hexvero_sourcemap`                          | Ursprüngliche Position zu einer generierten Zeile/Spalte                                                          |
| `hexvero_providers` · `hexvero_provider_run` | radare2, rizin oder Ghidra erkennen und ansteuern                                                                 |
| `hexvero_list` · `hexvero_close`             | Sitzungsverwaltung                                                                                                |

Bitten Sie Ihren Agenten: _„Öffne ~/Downloads/app.asar mit hexvero und sage mir, welche IPC-Kanäle der Renderer erreichen kann und ob nodeIntegration aktiviert ist.“_ Siehe [docs/mcp.md](docs/mcp.md).

<a id="optional-engines"></a>

## Optionale Engines

hexvero erkennt `r2`/`radare2`, `rizin` und Ghidras `analyzeHeadless` über `PATH` (oder `GHIDRA_INSTALL_DIR`). Ist eine dieser Engines installiert:

```bash
hexvero provider ./program radare2 functions
hexvero provider ./program ghidra decompile --address main
```

Ghidra importiert jedes Analyseobjekt einmal in ein unter `~/.cache/hexvero` zwischengespeichertes Projekt und verwendet dieses wieder. Die Engine-Ausgabe ist begrenzt, bei Zeitüberschreitungen wird die gesamte Prozessgruppe beendet, und fehlende Decompiler-Plugins werden als Einschränkung gemeldet, statt ein leeres Ergebnis zu liefern.

<a id="compared-with-rea"></a>

## Vergleich mit REA

[REA](https://github.com/morluto/rea) hat gezeigt, dass Bedarf an solchen Werkzeugen für Agenten besteht. hexvero ist eine schlankere Neuimplementierung, die bei den offenen Issues der REA-Nutzer ansetzt.

|                                                     | REA                                                                     | hexvero                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MCP-Tools / Katalog                                 | 139 Tools, ~2 MB                                                        | 15 Tools, < 32 KiB                                                             |
| Große Ergebnisse                                    | Ein einzelnes JSON-Dokument; 500-MB-Bundles führen zum Abbruch von Node | Seitenweise abrufbare Sammlungen mit Byte-Budgets; Export in eine Datei        |
| Analyse nativer Binärdateien ohne Engine            | Eingeschränkt                                                           | Vollständiges Parsen der Containerformate, Go, .NET, Fakten zu Schutzmaßnahmen |
| Installation                                        | Node + Ghidra/Hopper/IDA + JDK/Python für die meisten Analyseobjekte    | Nur Node; Engines optional                                                     |
| GUI                                                 | Keine                                                                   | Lokale Weboberfläche                                                           |
| Dynamische Analyse, Frida, ADB, Prozessaufzeichnung | Ja                                                                      | Nicht Teil des Funktionsumfangs                                                |

REA bietet wesentlich mehr Möglichkeiten für dynamische Analysen und Analysen über externe Werkzeuge. Wenn Sie bereits jetzt Hopper, IDA, Frida oder die Arbeit mit Android-Geräten benötigen, verwenden Sie REA.

<a id="how-it-works"></a>

## Funktionsweise

```text
packages/core     parsers (formats/*), JavaScript scanner, Session (targets, collections, paging, export)
packages/mcp      McpServer with 15 tools over one Session
packages/server   loopback HTTP API + static hosting for the UI
packages/cli      hexvero command; ships the built UI
packages/web      React + Vite UI
```

Jeder Parser liefert Fakten sowie `findings` und `limitations`. Die Session überführt eine Analyse in benannte Sammlungen und stellt sie seitenweise bereit; CLI, MCP und HTTP sind schlanke Adapter für dieselben Aufrufe. Die Tests bauen ihre Testdaten Byte für Byte auf (`packages/core/test/fixtures`), sodass die Testsuite überall innerhalb von Sekunden läuft. Siehe [docs/ARCHITECTURE-PLAN.md](docs/ARCHITECTURE-PLAN.md) und [CONTRIBUTING.md](CONTRIBUTING.md).

<a id="faq"></a>

## FAQ

<details><summary><b>Führt hexvero meine Dateien aus oder lädt sie hoch?</b></summary>

Nein. Analyseobjekte werden als Bytes geparst. Der Server der Weboberfläche lauscht auf 127.0.0.1 und verwendet ein sitzungsspezifisches Token. Es gibt weder Telemetrie noch Netzwerkaufrufe in der Codebasis.

</details>

<details><summary><b>Ist hexvero ein Decompiler?</b></summary>

Nicht allein. Die integrierte Analyse liefert Struktur, Symbole, Zeichenfolgen, Importe, Metadaten und Fakten zu Schutzmaßnahmen. Für Disassemblierung und Pseudocode installieren Sie radare2, rizin oder Ghidra und verwenden `hexvero provider`.

</details>

<details><summary><b>Wie sieht es mit Windows aus?</b></summary>

Die Parser und die CLI sind plattformunabhängig. Die Prozessgruppenverwaltung der Provider und die Tests mit simulierten Engines sind auf POSIX ausgelegt; die Engine-Unterstützung unter Windows ist ungetestet.

</details>

<details><summary><b>Rechtliches</b></summary>

hexvero dient der rechtmäßigen Forschung, der Lehre, der Interoperabilität und der Analyse von Software, die Ihnen gehört oder zu deren Untersuchung Sie berechtigt sind. Siehe [DISCLAIMER.md](DISCLAIMER.md).

</details>

## Lizenz

MIT
