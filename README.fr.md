<div align="center">

<img src="docs/logo.svg" width="88" height="88" alt="logo hexvero : un H ambre sur fond anthracite">

# hexvero

**Savoir ce qui a changé dans votre release Electron.**

Comparez deux builds d'une application Electron et voyez quels canaux IPC, membres du pont preload, réglages de fenêtre et hôtes réseau ont changé, avec fichier et ligne dans les deux builds.

[![CI](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/hexvero/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hexvero?style=flat-square&color=F2B84B&labelColor=1B1D21)](https://www.npmjs.com/package/hexvero)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-F2B84B?style=flat-square&labelColor=1B1D21)](package.json)
[![License](https://img.shields.io/badge/license-MIT-F2B84B?style=flat-square&labelColor=1B1D21)](LICENSE)

[Website](https://maximilianfeix.github.io/hexvero/) · [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

<br>

![30 secondes de sortie réelle : npx hexvero demo montre ce qui a changé entre deux builds d'une application d'exemple, hexvero check échoue avec le code de sortie 3, puis l'interface web locale ouvre les changements avec les lignes source des deux builds](docs/demo/release-review.gif)

</div>

> Le [README anglais](README.md) fait foi et est plus détaillé. Cette version le reflète à la date du 2026-10-31 (hexvero 0.12).

## Essayer en 10 secondes

```bash
npx hexvero demo
```

Nécessite Node.js 22.12 ou plus récent. Copie deux builds d'une petite application d'exemple (NotesDesk 1.4.0 et 1.5.0) dans `./hexvero-demo` et montre ce qui a changé, par exemple un nouveau membre preload `notesdesk.checkUpdate` (`preload.js:9`, handler `main.js:30`) et un canal IPC `shell:open` signalé comme **inconnu** plutôt que supprimé : le build 1.5.0 calcule les noms de canaux à l'exécution, et hexvero ne devine pas.

Comme barrière de release :

```text
$ npx hexvero check hexvero-demo/notesdesk-1.4.0.asar hexvero-demo/notesdesk-1.5.0.asar --policy hexvero-demo/policy.json
hexvero check fail: the policy is violated
  ✗ new-interface-member  notesdesk.checkUpdate  new · fail
  ✗ new-external-host  updates.notesdesk.example  new · fail
$ echo $?
3
```

`npx hexvero ui --demo --open` affiche la même comparaison dans l'interface web locale, avec les lignes source des deux builds côte à côte.

## Pourquoi

- **Une revue de release demande ce que la mise à jour a changé** : quels canaux une page peut désormais atteindre, quels membres preload sont nouveaux, quelle fenêtre est devenue plus permissive, quels serveurs le code appelle maintenant.
- **Un diff du bundle livré n'y répond pas.** C'est du JavaScript minifié dans un `app.asar` ; lancer l'application n'est pas toujours permis, et un scanner à liste de contrôle examine un build, pas le changement.
- **hexvero y répond à partir des fichiers** : chaque changement avec le fichier et la ligne dans les deux builds, ce qui n'a pas pu être établi, et une politique qui fait échouer la CI en cas de nouveau membre, de nouvel hôte ou de fenêtre plus permissive. Rien n'est exécuté.

## Sur votre propre application

```bash
npx hexvero compare old/YourApp.app new/YourApp.app --report report.html   # one offline HTML page
npx hexvero init old/YourApp.app                                            # starting policy, current hosts allowed
npx hexvero check old/YourApp.app new/YourApp.app --policy .hexvero/policy.json
npx hexvero audit YourApp.app --format sarif > audit.sarif                  # one build, Electronegativity-style checks
```

Entrées : un `app.asar`, une `.app` macOS, un répertoire d'installation Windows ou Linux, ou le `.zip` de release. Les installeurs (`.dmg`, `.exe` d'installation, AppImage) doivent d'abord être décompressés. Pour accepter l'état actuel une fois : `--baseline .hexvero/baseline.json --update-baseline` ; ensuite seuls les nouveaux constats font échouer.

Codes de sortie : `0` réussi, `3` politique violée, `4` indécidable, `1` erreur technique, `2` appel ou politique invalide. Sortie en texte, JSON, Markdown ou SARIF 2.1.0. Exemple de CI avec envoi SARIF : [docs/ci.md](docs/ci.md).

## Pour les agents IA

`npx hexvero setup --apply` enregistre le serveur MCP (16 outils, réponses courtes et paginées) auprès des agents de programmation trouvés. Le texte provenant de la cible analysée est traité comme des données, jamais comme des instructions. Avec un agent hébergé dans le cloud, les résultats demandés partent chez son fournisseur de modèle. Détails : [docs/mcp.md](docs/mcp.md).

## Comparaison et limites

- **Electronegativity** est archivé depuis le 2026-10-24. `hexvero audit` couvre une partie de ses contrôles, pas tous : [lesquels](https://maximilianfeix.github.io/hexvero/compare/electronegativity/).
- **REA** répond à une autre question (comment fonctionne une application tierce, avec décompilateurs et capture à l'exécution) : [positionnement](https://maximilianfeix.github.io/hexvero/compare/rea/).
- hexvero lit des fichiers et n'observe jamais un programme en cours d'exécution. Un constat dit ce que contient le code, pas ce qu'il fait ni s'il est exploitable. Il passe à côté de choses : [chiffres](docs/accuracy.md).
- Il lit aussi ELF, PE, Mach-O, Go, .NET, APK, WebAssembly, SQLite et d'autres : [formats](docs/formats.md).

## Licence

MIT. À utiliser uniquement sur des logiciels que vous avez le droit d'examiner ([DISCLAIMER.md](DISCLAIMER.md)).
