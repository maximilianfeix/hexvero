# hexvero 0.3.0 on the hexvero corpus

Tool: name hexvero · version 0.3.0 · commit a6d9b82 · node v24.21.0 · platform darwin arm64 · engines {"radare2":"radare2 6.2.4 +0 abi:152 @ darwin-arm_64","rizin":"rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)"} · observer corpus/observe-hexvero.mjs of that commit, unmodified

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| damaged | damaged input | 6 | 6 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| damaged | damaged/empty.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/header-cut.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/header-length-lies.asar | damaged input | 1 | 0 | 0 | error malformed |
| damaged | damaged/contents-cut.asar | damaged input | 1 | 0 | 0 | flagged (package_json_invalid, js_files_skipped) |
| damaged | damaged/load-commands-cut.macho-arm64 | damaged input | 1 | 0 | 0 | flagged (load_command_invalid, file_truncated) |
| damaged | damaged/body-cut.macho-arm64 | damaged input | 1 | 0 | 0 | flagged (file_truncated) |
