<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="logo do hexvero: um H âmbar sobre fundo grafite">

# hexvero

**Saiba o que mudou dentro do seu release Electron.**

Compare dois builds de um app Electron e veja quais canais IPC, membros da ponte de preload, configurações de janela e hosts de rede mudaram, com arquivo e linha nos dois builds.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · **Português (Brasil)** · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 segundos de saída real: npx hexvero demo mostra o que mudou entre dois builds de um app de exemplo, hexvero check falha com código de saída 3 e, em seguida, a interface web local abre as mudanças com as linhas de código dos dois builds](docs/demo/release-review.gif)

</div>

> O [README em inglês](README.md) é a referência e é mais detalhado. Esta versão o acompanha na data de 2026-10-31 (hexvero 0.12).

## Experimente em 10 segundos

```bash
npx hexvero demo
```

Requer Node.js 22.12 ou mais recente. Copia dois builds de um pequeno app de exemplo (NotesDesk 1.4.0 e 1.5.0) para `./hexvero-demo` e mostra o que mudou, por exemplo um novo membro de preload `notesdesk.checkUpdate` (`preload.js:9`, handler `main.js:30`) e um canal IPC `shell:open` informado como **desconhecido** em vez de removido: o build 1.5.0 calcula os nomes dos canais em tempo de execução, e o hexvero não chuta.

Como portão de release:

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` mostra a mesma comparação na interface web local, com as linhas de código dos dois builds lado a lado.

## Por quê

- **Uma revisão de release pergunta o que a atualização mudou**: quais canais uma página agora alcança, quais membros de preload são novos, qual janela ficou mais permissiva, quais servidores o código agora chama.
- **Um diff do bundle publicado não responde a isso.** É JavaScript minificado dentro de um `app.asar`; executar o app nem sempre é permitido, e um scanner de checklist olha um build, não a mudança.
- **O hexvero responde a partir dos arquivos**: cada mudança com o arquivo e a linha nos dois builds, o que não foi possível determinar, e uma política que faz a CI falhar diante de um novo membro, host ou janela mais permissiva. Nada é executado.

## No seu próprio app

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

Entradas: um `app.asar`, um `.app` do macOS, um diretório de instalação do Windows ou Linux, ou o `.zip` do release. Instaladores (`.dmg`, `.exe` de instalação, AppImage) precisam ser descompactados antes. Para aceitar o estado atual uma vez: `--baseline .hexvero/baseline.json --update-baseline`; depois disso, só os achados novos fazem falhar.

Códigos de saída: `0` aprovado, `3` política violada, `4` não decidível, `1` erro técnico, `2` chamada ou política inválida. Saída em texto, JSON, Markdown ou SARIF 2.1.0. Exemplo de CI com envio de SARIF: [docs/ci.md](docs/ci.md).

## Para agentes de IA

`npx hexvero setup --apply` registra o servidor MCP (16 ferramentas, respostas pequenas e paginadas) nos agentes de programação encontrados. O texto vindo do alvo analisado é tratado como dado, nunca como instrução. Com um agente na nuvem, os resultados solicitados vão para o provedor de modelo dele. Detalhes: [docs/mcp.md](docs/mcp.md).

## Comparação e limites

- **Electronegativity** está arquivado desde 2026-10-24. O `hexvero audit` cobre parte das verificações dele, não todas: [quais](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA** responde a outra pergunta (como funciona um app de terceiros, com decompiladores e captura em execução): [comparação](https://maximilianfeix.github.io/hexvero/compare/rea/).
- O hexvero lê arquivos e nunca observa um programa em execução. Um achado diz o que o código contém, não o que ele faz nem se é explorável. Ele deixa coisas passar: [números](docs/accuracy.md).
- Além disso, lê ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite e mais: [formatos](docs/formats.md).

## Licença

MIT. Use apenas em software que você tem permissão para examinar ([DISCLAIMER.md](DISCLAIMER.md)).
