<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="hexvero のロゴ：チャコール地に琥珀色の H">

# hexvero

**Electron のリリースで何が変わったかを知る。**

Electron アプリの 2 つのビルドを比較し、変わった IPC チャネル、preload ブリッジのメンバー、ウィンドウ設定、ネットワークホストを、両ビルドのファイルと行つきで確認できます。

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · **日本語** · [한국어](README.ko.md)

<br>

![30 秒の実際の出力：npx hexvero demo がサンプルアプリの 2 つのビルド間の変更を表示し、hexvero check が終了コード 3 で失敗し、続いてローカルの Web UI が両ビルドのソース行つきで変更を開く](docs/demo/release-review.gif)

</div>

> [英語版 README](README.md) が正本で、より詳しい内容です。この版は 2026-10-31 時点（hexvero 0.12）の英語版に対応しています。

## 10 秒で試す

```bash
npx hexvero demo
```

Node.js 22.12 以降が必要です。小さなサンプルアプリの 2 つのビルド（NotesDesk 1.4.0 と 1.5.0）を `./hexvero-demo` にコピーし、何が変わったかを表示します。たとえば新しい preload メンバー `notesdesk.checkUpdate`（`preload.js:9`、ハンドラー `main.js:30`）と、削除ではなく**不明**として報告される IPC チャネル `shell:open` です。1.5.0 のビルドはチャネル名を実行時に計算するため、hexvero は推測しません。

リリースゲートとして：

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` は、同じ比較をローカルの Web UI で表示し、両ビルドのソース行を並べて見せます。

## なぜ必要か

- **リリースレビューで問われるのは、アップデートで何が変わったか**です。ページがどのチャネルに届くようになったか、どの preload メンバーが増えたか、どのウィンドウが緩くなったか、コードがどのサーバーを呼ぶようになったか。
- **配布されたバンドルの diff では答えられません。** `app.asar` の中にある minify 済みの JavaScript であり、アプリを実行して調べることは常に許されるわけではなく、チェックリスト型のスキャナーは変更ではなく 1 つのビルドを見ます。
- **hexvero はファイルから答えます。** 両ビルドでの各変更のファイルと行、確定できなかった点、そして新しいメンバー・ホスト・より緩いウィンドウで CI を失敗させるポリシー。何も実行しません。

## 自分のアプリで使う

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

入力：`app.asar`、macOS の `.app`、Windows または Linux のインストールディレクトリ、または公開するリリースの `.zip`。インストーラー（`.dmg`、セットアップ `.exe`、AppImage）は先に展開してください。現状を一度受け入れるには `--baseline .hexvero/baseline.json --update-baseline` を使います。以降は新しい検出だけが失敗になります。

終了コード：`0` 合格、`3` ポリシー違反、`4` 判定不能、`1` 技術的エラー、`2` 呼び出しまたはポリシーが不正。出力形式はテキスト、JSON、Markdown、SARIF 2.1.0。SARIF アップロードを含む CI の例：[docs/ci.md](docs/ci.md)。

## AI エージェント向け

`npx hexvero setup --apply` は、見つかったコーディングエージェントに MCP サーバー（16 ツール、小さなページ単位の応答）を登録します。解析対象に含まれるテキストはデータとして扱い、指示としては扱いません。クラウド上のエージェントを使う場合、要求した結果はそのモデル提供元に送られます。詳細：[docs/mcp.md](docs/mcp.md)。

## 比較と限界

- **Electronegativity** は 2026-10-24 にアーカイブされました。`hexvero audit` はそのチェックの一部をカバーしますが、すべてではありません：[対象の一覧](https://maximilianfeix.github.io/hexvero/compare/electronegativity/)。
- **REA** は別の問いに答えます（他人のアプリがどう動くか。デコンパイラーと実行時キャプチャを使用）：[比較](https://maximilianfeix.github.io/hexvero/compare/rea/)。
- hexvero はファイルを読むだけで、動作中のプログラムは観察しません。検出結果が示すのはコードに何が含まれるかであり、何をするか、悪用可能かどうかではありません。見落としもあります：[数値](docs/accuracy.md)。
- そのほか ELF、PE、Mach-O、Go、.NET、APK、WebAssembly、SQLite なども読めます：[フォーマット](docs/formats.md)。

## ライセンス

MIT。調査する権限のあるソフトウェアにのみ使用してください（[DISCLAIMER.md](DISCLAIMER.md)）。
