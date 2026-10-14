# REA 6.4.0 on the hexvero corpus

Tool: name REA · version 6.4.0 · package rea-agents · cli 6.4.0 · node v24.21.0 · platform darwin arm64 · mapping alternative: store calls counted as storage · deep providers none installed (Ghidra, Hopper, IDA)

## Per class

| set | class | inputs | hit | missed | false | not found but warned |
| --- | --- | --- | --- | --- | --- | --- |
| damaged | damaged input | 6 | 6 | 0 | 0 |  |

## Per input

| set | input | class | hit | missed | false | notes |
| --- | --- | --- | --- | --- | --- | --- |
| damaged | damaged/empty.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/header-cut.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/header-length-lies.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/contents-cut.asar | damaged input | 1 | 0 | 0 | error artifact_operation_failed |
| damaged | damaged/load-commands-cut.macho-arm64 | damaged input | 1 | 0 | 0 | error target_unavailable |
| damaged | damaged/body-cut.macho-arm64 | damaged input | 1 | 0 | 0 | error execution_failure |
