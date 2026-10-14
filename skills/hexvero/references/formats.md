# Other formats

| Target               | Collections                                                                   | Notes                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| APK                  | `permissions`, `components`, `classes`, `packages`, `dexFiles`, `libraries`   | a declared permission is not proof of use; an exported component is reachable by other apps only if the manifest says so |
| DEX, JAR, Java class | `classes`, `packages`, `methods`, `referencedMethods`, `constants`            |                                                                                                                          |
| .NET assembly        | `types`, `methods`, `calls`, `cil`, `pinvokes`, `userStrings`, `assemblyRefs` | `pinvokes` are native calls                                                                                              |
| Go binary            | `goDependencies`                                                              | module paths and versions from the build info; stripped binaries say so in `limitations`                                 |
| WebAssembly          | `imports`, `exports`, `types`, `sections`                                     |                                                                                                                          |
| SQLite               | `tables`, `columns`, `indexes`, `triggers`, `samples`                         | samples are a few rows, not the data                                                                                     |
| HAR capture          | `requests`, `hosts`, `endpoints`                                              | observed traffic, not the complete API; redact credentials and personal data                                             |
| JavaScript bundle    | `bundleModules`, `endpoints`, `routes`, `storage`, `urls`                     | `hexvero_recover` writes the modules as files                                                                            |
| Source map           | `sources`, `packages`                                                         | `hexvero_recover` writes embedded original sources                                                                       |
| macOS/iOS `.app`     | bundle facts, then the main executable as a native binary                     | entitlements and signature in findings                                                                                   |
