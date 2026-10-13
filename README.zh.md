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

[English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · **中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

---

**在信任、运行或重写一个文件之前，先弄清它里面有什么。** hexvero 在你的机器上读取可执行文件、应用包、数据库和抓包记录，**从不执行它们**，并说明找到了什么、置信度如何、哪些无法确定。它包含一个 CLI、一个面向编码代理的精简 MCP 服务器和一个本地 Web 界面。解析器只依赖 Node.js。

## 安装

需要 Node.js ≥ 22.12。`npx hexvero` 无需安装即可使用；`npm i -g hexvero` 安装 `hexvero` 命令。

## 支持的格式

ELF、PE、Mach-O（含 fat）、Go buildinfo、.NET 程序集（元数据与 CIL 方法体）、WebAssembly、EVM 字节码、SQLite、plist、HAR、ZIP/ZIP64、APK（AXML、resources.arsc、DEX）、JAR/Java 类、Electron ASAR、JavaScript 打包文件（webpack、Rspack、browserify、esbuild）及 source map、带 Objective-C 与 Swift 元数据的 Apple .app 包、Flutter 快照。每条结果都标注置信度（`confirmed` 或 `inferred`）并明确列出局限。

## CLI

```bash
npx hexvero analyze ./program                 # 摘要、发现、局限
npx hexvero collection ./program imports      # 分页查看一个列表
npx hexvero strings ./program --tag url       # 带标签的字符串
npx hexvero recover ./bundle.js ./out         # 把打包文件拆成模块
npx hexvero calls ./program radare2 main      # 有界调用图（需 radare2/rizin/Ghidra）
npx hexvero ui --open                         # 本地 Web 界面
npx hexvero setup --apply                     # 注册 MCP 服务器
```

## 面向 AI 代理

`hexvero mcp` 通过 stdio 提供 15 个工具，目录小于 32 KiB：打开、分析、分页浏览集合和字符串、读取字节、导出、比较、恢复源码以及驱动外部引擎。`hexvero setup --apply` 会把服务器注册到 Claude Code、Claude Desktop、Codex、Cursor、Windsurf、Gemini CLI、VS Code、OpenCode、Copilot CLI 等已检测到的客户端。

## 可选引擎

radare2、rizin 和 Ghidra 会从 `PATH` 中自动检测；hexvero 从不替你安装。装有其一时可用：反汇编、反编译、交叉引用、调用者/被调用者、调用图和搜索，全部有界并带缓存。

完整文档为英文：[README.md](README.md)、[docs/cli.md](docs/cli.md)、[docs/mcp.md](docs/mcp.md)。

## 许可证

MIT。
