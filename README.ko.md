<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="hexvero 로고: 차콜 바탕의 호박색 H">

# hexvero

**Electron 릴리스에서 무엇이 바뀌었는지 알아보세요.**

Electron 앱의 두 빌드를 비교해 어떤 IPC 채널, preload 브리지 멤버, 창 설정, 네트워크 호스트가 바뀌었는지 두 빌드의 파일과 줄 번호와 함께 확인합니다.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · **한국어**

<br>

![30초 실제 출력: npx hexvero demo가 예제 앱의 두 빌드 사이에서 바뀐 내용을 보여 주고, hexvero check가 종료 코드 3으로 실패한 뒤, 로컬 웹 UI가 두 빌드의 소스 줄과 함께 변경 사항을 엽니다](docs/demo/release-review.gif)

</div>

> [영어 README](README.md)가 기준이며 더 자세합니다. 이 버전은 2026-10-31(hexvero 0.12) 기준으로 영어 README를 따릅니다.

## 10초 만에 써 보기

```bash
npx hexvero demo
```

Node.js 22.12 이상이 필요합니다. 작은 예제 앱의 두 빌드(NotesDesk 1.4.0과 1.5.0)를 `./hexvero-demo`에 복사하고 무엇이 바뀌었는지 보여 줍니다. 예를 들어 새 preload 멤버 `notesdesk.checkUpdate`(`preload.js:9`, 핸들러 `main.js:30`)와, 삭제가 아니라 **알 수 없음**으로 보고되는 IPC 채널 `shell:open`이 있습니다. 1.5.0 빌드는 채널 이름을 실행 시점에 계산하므로 hexvero는 추측하지 않습니다.

릴리스 게이트로 사용하면:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open`은 같은 비교를 로컬 웹 UI에서 보여 주며, 두 빌드의 소스 줄을 나란히 표시합니다.

## 왜 필요한가

- **릴리스 리뷰가 묻는 것은 업데이트로 무엇이 바뀌었는가**입니다. 페이지가 이제 어떤 채널에 닿는지, 어떤 preload 멤버가 새로 생겼는지, 어떤 창이 더 느슨해졌는지, 코드가 이제 어떤 서버를 호출하는지입니다.
- **배포된 번들의 diff로는 답할 수 없습니다.** `app.asar` 안의 minify된 JavaScript이고, 앱을 실행해 확인하는 것이 항상 허용되는 것도 아니며, 체크리스트 방식 스캐너는 변경이 아니라 하나의 빌드를 봅니다.
- **hexvero는 파일에서 답을 냅니다.** 두 빌드에서의 각 변경을 파일과 줄 번호와 함께, 확정하지 못한 부분, 그리고 새 멤버나 호스트, 더 느슨해진 창이 생기면 CI를 실패시키는 정책을 제공합니다. 아무것도 실행하지 않습니다.

## 내 앱에 적용하기

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

입력: `app.asar`, macOS `.app`, Windows 또는 Linux 설치 디렉터리, 또는 배포하는 릴리스 `.zip`. 설치 프로그램(`.dmg`, 설치용 `.exe`, AppImage)은 먼저 풀어야 합니다. 현재 상태를 한 번 수용하려면 `--baseline .hexvero/baseline.json --update-baseline`을 사용하세요. 이후에는 새로운 발견 사항만 실패로 처리됩니다.

종료 코드: `0` 통과, `3` 정책 위반, `4` 판정 불가, `1` 기술적 오류, `2` 잘못된 호출 또는 정책. 출력은 텍스트, JSON, Markdown, SARIF 2.1.0 중에서 고를 수 있습니다. SARIF 업로드를 포함한 CI 예시: [docs/ci.md](docs/ci.md).

## AI 에이전트용

`npx hexvero setup --apply`는 발견한 코딩 에이전트에 MCP 서버(도구 16개, 작은 페이지 단위 응답)를 등록합니다. 분석 대상 안의 텍스트는 데이터로 취급하며 지시로 취급하지 않습니다. 클라우드 에이전트를 쓰면 요청한 결과가 해당 모델 제공자에게 전달됩니다. 자세한 내용: [docs/mcp.md](docs/mcp.md).

## 비교와 한계

- **Electronegativity**는 2026-10-24부터 아카이브되었습니다. `hexvero audit`는 그 검사의 일부를 다루며 전부는 아닙니다: [어떤 검사인지](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA**는 다른 질문에 답합니다(남의 앱이 어떻게 동작하는지, 디컴파일러와 실행 중 캡처 사용): [비교](https://maximilianfeix.github.io/hexvero/compare/rea/).
- hexvero는 파일을 읽을 뿐 실행 중인 프로그램을 관찰하지 않습니다. 발견 사항은 코드에 무엇이 들어 있는지를 말해 줄 뿐, 코드가 무엇을 하는지나 악용 가능한지는 말해 주지 않습니다. 놓치는 것도 있습니다: [수치](docs/accuracy.md).
- 그 밖에 ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite 등도 읽습니다: [형식](docs/formats.md).

## 라이선스

MIT. 조사할 권한이 있는 소프트웨어에만 사용하세요([DISCLAIMER.md](DISCLAIMER.md)).
