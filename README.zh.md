<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="hexvero 标志：炭黑底色上的琥珀色 H">

# hexvero

**弄清你的 Electron 发布版本里改了什么。**

比较一个 Electron 应用的两个构建，查看哪些 IPC 通道、preload 桥接成员、窗口设置和网络主机发生了变化，并给出两个构建中的文件和行号。

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · **中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 秒真实输出：npx hexvero demo 显示示例应用两个构建之间的变化，hexvero check 以退出码 3 失败，随后本地网页界面打开这些变化，并列出两个构建的源码行](docs/demo/release-review.gif)

</div>

> [英文 README](README.md) 为准，内容也更详细。本版本与其保持一致，截至 2026-10-31（hexvero 0.12）。

## 10 秒试用

```bash
npx hexvero demo
```

需要 Node.js 22.12 或更高版本。它会把一个小型示例应用的两个构建（NotesDesk 1.4.0 和 1.5.0）复制到 `./hexvero-demo` 并显示发生了什么变化，例如新增的 preload 成员 `notesdesk.checkUpdate`（`preload.js:9`，处理函数 `main.js:30`），以及被报告为**未知**而不是已移除的 IPC 通道 `shell:open`：1.5.0 构建在运行时计算通道名，hexvero 不做猜测。

作为发布门禁：

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` 在本地网页界面中显示同样的比较，两个构建的源码行并排展示。

## 为什么

- **发布评审要问的是这次更新改了什么**：页面现在能访问哪些通道、哪些 preload 成员是新增的、哪个窗口变得更宽松、代码现在会调用哪些服务器。
- **对已发布的包做 diff 回答不了这个问题。** 它是 `app.asar` 里被压缩的 JavaScript；并非总是允许运行应用来查看，而清单式扫描器只看一个构建，看不到变化。
- **hexvero 直接从文件中回答**：每处变化都带有两个构建中的文件和行号、哪些无法确定，以及一份策略，在出现新成员、新主机或更宽松的窗口时让 CI 失败。不会执行任何代码。

## 用于你自己的应用

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

输入：`app.asar`、macOS 的 `.app`、Windows 或 Linux 的安装目录，或发布的 `.zip`。安装包（`.dmg`、安装用 `.exe`、AppImage）需要先解包。要一次性接受当前状态：`--baseline .hexvero/baseline.json --update-baseline`；之后只有新的发现才会导致失败。

退出码：`0` 通过，`3` 违反策略，`4` 无法判定，`1` 技术错误，`2` 调用或策略无效。输出格式可选文本、JSON、Markdown 或 SARIF 2.1.0。带 SARIF 上传的 CI 示例：[docs/ci.md](docs/ci.md)。

## 面向 AI 智能体

`npx hexvero setup --apply` 会把 MCP 服务器（16 个工具，小体量分页响应）注册到找到的编码智能体中。被分析目标中的文本一律视为数据，绝不当作指令。使用云端智能体时，其请求的结果会发送给它的模型提供方。详情：[docs/mcp.md](docs/mcp.md)。

## 对比与局限

- **Electronegativity** 自 2026-10-24 起已归档。`hexvero audit` 覆盖了它的一部分检查，而非全部：[覆盖哪些](https://maximilianfeix.github.io/hexvero/compare/electronegativity/)。
- **REA** 回答的是另一个问题（别人的应用是如何工作的，带反编译器和运行时捕获）：[对比](https://maximilianfeix.github.io/hexvero/compare/rea/)。
- hexvero 读取文件，从不观察运行中的程序。一项发现说明代码里有什么，而不是它做了什么，也不代表可被利用。它会有遗漏：[数据](docs/accuracy.md)。
- 此外它还能读取 ELF、PE、Mach-O、Go、.NET、APK、WebAssembly、SQLite 等：[格式](docs/formats.md)。

## 许可证

MIT。仅用于你有权检查的软件（[DISCLAIMER.md](DISCLAIMER.md)）。
