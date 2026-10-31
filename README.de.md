<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="hexvero-Logo: ein bernsteinfarbenes H auf Anthrazit">

# hexvero

**Wissen, was sich in deinem Electron-Release geändert hat.**

Vergleiche zwei Builds einer Electron-App und sieh, welche IPC-Kanäle, Preload-Bridge-Mitglieder, Fenstereinstellungen und Netzwerk-Hosts sich geändert haben, mit Datei und Zeile in beiden Builds.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 Sekunden echte Ausgabe: npx hexvero demo zeigt, was sich zwischen zwei Builds einer Beispiel-App geändert hat, hexvero check scheitert mit Exit-Code 3, danach öffnet die lokale Weboberfläche die Änderungen mit den Quellzeilen beider Builds](docs/demo/release-review.gif)

</div>

> Die [englische README](README.md) ist maßgeblich und ausführlicher. Diese Fassung entspricht ihr mit Stand 2026-10-31 (hexvero 0.12).

## In 10 Sekunden ausprobieren

```bash
npx hexvero demo
```

Benötigt Node.js 22.12 oder neuer. Kopiert zwei Builds einer kleinen Beispiel-App (NotesDesk 1.4.0 und 1.5.0) nach `./hexvero-demo` und zeigt, was sich geändert hat, zum Beispiel ein neues Preload-Mitglied `notesdesk.checkUpdate` (`preload.js:9`, Handler `main.js:30`) und einen IPC-Kanal `shell:open`, der als **unbekannt** gemeldet wird statt als entfernt: Build 1.5.0 berechnet Kanalnamen zur Laufzeit, hexvero rät nicht.

Als Release-Gate:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` zeigt denselben Vergleich in der lokalen Weboberfläche, mit den Quellzeilen beider Builds nebeneinander.

## Warum

- **Ein Release-Review fragt, was das Update geändert hat**: welche Kanäle eine Seite jetzt erreicht, welche Preload-Mitglieder neu sind, welches Fenster freizügiger wurde, welche Server der Code jetzt aufruft.
- **Ein Diff des ausgelieferten Bundles beantwortet das nicht.** Es ist minifiziertes JavaScript in einer `app.asar`; die App zu starten ist nicht immer erlaubt, und ein Checklisten-Scanner sieht einen Build, nicht die Änderung.
- **hexvero beantwortet es aus den Dateien**: jede Änderung mit Datei und Zeile in beiden Builds, was sich nicht feststellen ließ, und eine Policy, die CI bei einem neuen Mitglied, Host oder freizügigeren Fenster scheitern lässt. Nichts wird ausgeführt.

## An der eigenen App

```bash
npx hexvero compare alt/DeineApp.app neu/DeineApp.app --report report.html   # eine Offline-HTML-Seite
npx hexvero init alt/DeineApp.app                                             # Start-Policy, heutige Hosts erlaubt
npx hexvero check alt/DeineApp.app neu/DeineApp.app --policy .hexvero/policy.json
npx hexvero audit DeineApp.app --format sarif > audit.sarif                   # ein Build, Checks wie in Electronegativity
```

Eingaben: eine `app.asar`, eine macOS-`.app`, ein Windows- oder Linux-Installationsordner oder die Release-`.zip`. Installer (`.dmg`, Setup-`.exe`, AppImage) vorher entpacken. Den heutigen Stand einmal akzeptieren: `--baseline .hexvero/baseline.json --update-baseline`; danach scheitern nur neue Befunde.

Exit-Codes: `0` bestanden, `3` verletzt, `4` nicht entscheidbar, `1` technischer Fehler, `2` Aufruf oder Policy ungültig. Ausgabe als Text, JSON, Markdown oder SARIF 2.1.0. CI-Beispiel mit SARIF-Upload: [docs/ci.md](docs/ci.md).

## Für KI-Agenten

`npx hexvero setup --apply` trägt den MCP-Server (16 Tools, kleine seitenweise Antworten) in die gefundenen Coding-Agenten ein. Text aus der untersuchten Datei gilt als Daten, nie als Anweisung. Mit einem Cloud-Agenten gehen die abgefragten Ergebnisse an dessen Modellanbieter. Details: [docs/mcp.md](docs/mcp.md).

## Vergleich und Grenzen

- **Electronegativity** ist seit 2026-10-24 archiviert. `hexvero audit` deckt einen Teil seiner Checks ab, nicht alle: [welche](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA** beantwortet eine andere Frage (wie eine fremde App funktioniert, mit Decompilern und Laufzeit-Mitschnitt): [Einordnung](https://maximilianfeix.github.io/hexvero/compare/rea/).
- hexvero liest Dateien und beobachtet nie ein laufendes Programm. Ein Befund sagt, was der Code enthält, nicht, was er tut oder ob etwas ausnutzbar ist. Es verpasst Dinge: [Zahlen](docs/accuracy.md).
- Daneben liest es ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite und mehr: [Formate](docs/formats.md).

## Lizenz

MIT. Nur auf Software anwenden, die du untersuchen darfst ([DISCLAIMER.md](DISCLAIMER.md)).
