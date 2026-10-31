<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="логотип hexvero: янтарная буква H на графитовом фоне">

# hexvero

**Узнайте, что изменилось внутри вашего релиза Electron.**

Сравните две сборки приложения на Electron и посмотрите, какие IPC-каналы, члены preload-моста, настройки окон и сетевые хосты изменились, с файлом и строкой в обеих сборках.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · **Русский** · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 секунд реального вывода: npx hexvero demo показывает, что изменилось между двумя сборками примера приложения, hexvero check завершается с кодом 3, затем локальный веб-интерфейс открывает изменения со строками исходного кода обеих сборок](docs/demo/release-review.gif)

</div>

> [Английский README](README.md) является основным и более подробным. Эта версия соответствует ему по состоянию на 2026-10-31 (hexvero 0.12).

## Попробовать за 10 секунд

```bash
npx hexvero demo
```

Требуется Node.js 22.12 или новее. Копирует две сборки небольшого примера приложения (NotesDesk 1.4.0 и 1.5.0) в `./hexvero-demo` и показывает, что изменилось, например новый член preload `notesdesk.checkUpdate` (`preload.js:9`, обработчик `main.js:30`) и IPC-канал `shell:open`, который помечен как **неизвестный**, а не удалённый: сборка 1.5.0 вычисляет имена каналов во время выполнения, а hexvero не гадает.

В качестве проверки релиза:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` показывает то же сравнение в локальном веб-интерфейсе, со строками исходного кода обеих сборок рядом.

## Зачем

- **Ревью релиза спрашивает, что изменило обновление**: до каких каналов теперь может добраться страница, какие члены preload появились, какое окно стало менее строгим, к каким серверам код теперь обращается.
- **Diff поставляемого бандла на это не отвечает.** Это минифицированный JavaScript внутри `app.asar`; запускать приложение не всегда разрешено, а сканер по чек-листу смотрит на одну сборку, а не на изменение.
- **hexvero отвечает по файлам**: каждое изменение с файлом и строкой в обеих сборках, то, что установить не удалось, и политика, которая валит CI при новом члене, новом хосте или более мягком окне. Ничего не выполняется.

## На вашем приложении

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

Входные данные: `app.asar`, macOS-`.app`, каталог установки Windows или Linux либо релизный `.zip`. Установщики (`.dmg`, установочный `.exe`, AppImage) сначала нужно распаковать. Чтобы один раз принять текущее состояние: `--baseline .hexvero/baseline.json --update-baseline`; после этого проверка падает только на новых находках.

Коды выхода: `0` пройдено, `3` политика нарушена, `4` решить нельзя, `1` техническая ошибка, `2` неверный вызов или политика. Вывод в виде текста, JSON, Markdown или SARIF 2.1.0. Пример CI с загрузкой SARIF: [docs/ci.md](docs/ci.md).

## Для ИИ-агентов

`npx hexvero setup --apply` регистрирует MCP-сервер (16 инструментов, небольшие постраничные ответы) в найденных агентах для программирования. Текст из исследуемого файла считается данными, а не инструкциями. При работе с облачным агентом запрошенные результаты уходят его поставщику модели. Подробности: [docs/mcp.md](docs/mcp.md).

## Сравнение и ограничения

- **Electronegativity** в архиве с 2026-10-24. `hexvero audit` покрывает часть его проверок, но не все: [какие именно](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA** отвечает на другой вопрос (как устроено чужое приложение, с декомпиляторами и записью во время выполнения): [сравнение](https://maximilianfeix.github.io/hexvero/compare/rea/).
- hexvero читает файлы и никогда не наблюдает работающую программу. Находка говорит, что содержит код, а не что он делает и можно ли это использовать. Он кое-что пропускает: [цифры](docs/accuracy.md).
- Кроме того, он читает ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite и другое: [форматы](docs/formats.md).

## Лицензия

MIT. Применяйте только к программам, которые вам разрешено исследовать ([DISCLAIMER.md](DISCLAIMER.md)).
