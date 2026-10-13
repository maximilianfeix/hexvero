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

[English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · **한국어**

</div>

---

**파일을 신뢰하거나 실행하거나 다시 구현하기 전에 그 안에 무엇이 있는지 확인하세요.** hexvero는 실행 파일, 앱 번들, 데이터베이스, 트래픽 캡처를 사용자의 컴퓨터에서 **실행하지 않고** 읽어, 무엇을 찾았는지, 얼마나 확실한지, 무엇을 판단할 수 없었는지 보여 줍니다. CLI, 코딩 에이전트용 소형 MCP 서버, 로컬 웹 UI를 하나로 제공합니다. 파서는 Node.js만 있으면 됩니다.

## 설치

Node.js ≥ 22.12가 필요합니다. `npx hexvero`는 설치 없이 동작하며, `npm i -g hexvero`는 `hexvero` 명령을 설치합니다.

## 읽을 수 있는 형식

ELF, PE, Mach-O(fat 포함), Go buildinfo, .NET 어셈블리(메타데이터와 CIL 메서드 본문), WebAssembly, EVM 바이트코드, SQLite, plist, HAR, ZIP/ZIP64, APK(AXML, resources.arsc, DEX), JAR/Java 클래스, Electron ASAR, JavaScript 번들(webpack, Rspack, browserify, esbuild)과 source map, Objective-C/Swift 메타데이터가 있는 Apple .app 번들, Flutter 스냅샷. 모든 결과에는 신뢰도(`confirmed` 또는 `inferred`)와 명시적인 한계가 붙습니다.

<!-- unreleased-note:start -->

> **버전 안내.** 이 문서는 `main` 기준입니다. npm에는 배지에 표시된 버전이 배포되어 있으며, `recover`, `calls` 등 새 기능은 [changelog](CHANGELOG.md)의 _Unreleased_ 항목에 있고 다음 릴리스에 포함됩니다.

<!-- unreleased-note:end -->

## CLI

```bash
npx hexvero analyze ./program                 # 요약, 발견 사항, 한계
npx hexvero collection ./program imports      # 목록을 페이지 단위로 보기
npx hexvero strings ./program --tag url       # 태그가 붙은 문자열
npx hexvero recover ./bundle.js ./out         # 번들을 모듈로 분리
npx hexvero calls ./program radare2 main      # 범위가 제한된 호출 그래프(radare2/rizin/Ghidra 필요)
npx hexvero ui --open                         # 로컬 웹 UI
npx hexvero setup --apply                     # MCP 서버 등록
```

## AI 에이전트용

`hexvero mcp`는 stdio로 15개의 도구를 제공하며 카탈로그는 32 KiB 미만입니다: 열기, 분석, 컬렉션과 문자열 페이지 보기, 바이트 읽기, 내보내기, 비교, 소스 복구, 외부 엔진 실행. `hexvero setup --apply`는 Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI, VS Code, OpenCode, Copilot CLI 등 감지된 클라이언트에 서버를 등록합니다.

## 선택적 엔진

radare2, rizin, Ghidra는 `PATH`에서 감지되며 hexvero가 대신 설치하지는 않습니다. 하나라도 있으면 디스어셈블, 디컴파일, 상호 참조, 호출자/피호출자, 호출 그래프, 검색을 범위 제한과 캐시와 함께 사용할 수 있습니다.

전체 문서는 영어로 제공됩니다: [README.md](README.md), [docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md).

## 라이선스

MIT.
