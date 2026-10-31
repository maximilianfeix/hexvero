<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="logo de hexvero: una H ámbar sobre fondo carbón">

# hexvero

**Saber qué cambió dentro de tu versión de Electron.**

Compara dos builds de una app Electron y ve qué canales IPC, miembros del puente de preload, ajustes de ventana y hosts de red cambiaron, con archivo y línea en ambos builds.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 segundos de salida real: npx hexvero demo muestra qué cambió entre dos builds de una app de ejemplo, hexvero check falla con código de salida 3 y después la interfaz web local abre los cambios con las líneas de código de ambos builds](docs/demo/release-review.gif)

</div>

> El [README en inglés](README.md) es el de referencia y es más detallado. Esta versión lo refleja a fecha de 2026-10-31 (hexvero 0.12).

## Pruébalo en 10 segundos

```bash
npx hexvero demo
```

Requiere Node.js 22.12 o superior. Copia dos builds de una pequeña app de ejemplo (NotesDesk 1.4.0 y 1.5.0) en `./hexvero-demo` y muestra qué cambió, por ejemplo un miembro de preload nuevo, `notesdesk.checkUpdate` (`preload.js:9`, handler `main.js:30`), y un canal IPC `shell:open` que se informa como **desconocido** en lugar de eliminado: el build 1.5.0 calcula los nombres de canal en tiempo de ejecución y hexvero no adivina.

Como puerta de release:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` muestra la misma comparación en la interfaz web local, con las líneas de código de ambos builds una junto a otra.

## Por qué

- **Una revisión de release pregunta qué cambió con la actualización**: a qué canales llega ahora una página, qué miembros de preload son nuevos, qué ventana se volvió más permisiva, a qué servidores llama ahora el código.
- **Un diff del bundle publicado no responde a eso.** Es JavaScript minificado dentro de un `app.asar`; ejecutar la app no siempre está permitido, y un escáner de listas de comprobación mira un build, no el cambio.
- **hexvero lo responde a partir de los archivos**: cada cambio con el archivo y la línea de ambos builds, lo que no se pudo determinar, y una política que hace fallar la CI ante un miembro, host o ventana más permisiva nuevos. No se ejecuta nada.

## En tu propia app

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

Entradas: un `app.asar`, una `.app` de macOS, un directorio de instalación de Windows o Linux, o el `.zip` del release. Los instaladores (`.dmg`, `.exe` de instalación, AppImage) hay que descomprimirlos antes. Para aceptar el estado actual una vez: `--baseline .hexvero/baseline.json --update-baseline`; después solo fallan los hallazgos nuevos.

Códigos de salida: `0` correcto, `3` política violada, `4` no decidible, `1` error técnico, `2` uso o política no válidos. Salida en texto, JSON, Markdown o SARIF 2.1.0. Ejemplo de CI con subida de SARIF: [docs/ci.md](docs/ci.md).

## Para agentes de IA

`npx hexvero setup --apply` registra el servidor MCP (16 herramientas, respuestas pequeñas y paginadas) en los agentes de programación que encuentre. El texto del objetivo analizado se trata como datos, nunca como instrucciones. Con un agente en la nube, los resultados que solicita van a su proveedor de modelo. Detalles: [docs/mcp.md](docs/mcp.md).

## Comparación y límites

- **Electronegativity** está archivado desde 2026-10-24. `hexvero audit` cubre una parte de sus comprobaciones, no todas: [cuáles](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA** responde a otra pregunta (cómo funciona una app ajena, con decompiladores y captura en ejecución): [comparación](https://maximilianfeix.github.io/hexvero/compare/rea/).
- hexvero lee archivos y nunca observa un programa en ejecución. Un hallazgo dice qué contiene el código, no qué hace ni si es explotable. Se le escapan cosas: [cifras](docs/accuracy.md).
- Además lee ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite y más: [formatos](docs/formats.md).

## Licencia

MIT. Úsalo solo en software que tengas permiso para examinar ([DISCLAIMER.md](DISCLAIMER.md)).
