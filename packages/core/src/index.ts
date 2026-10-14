export * from "./model.js";
export * from "./target.js";
export { detectFormat } from "./formats/detect.js";
export { parseElf, type ElfInfo, type ElfSymbol, type ElfSection } from "./formats/elf.js";
export { parsePe, shannonEntropy, type PeInfo } from "./formats/pe.js";
export { parseMacho, parseMachoFat, type MachoInfo, type MachoFatInfo } from "./formats/macho.js";
export {
  extractStrings,
  classifyString,
  STRING_TAGS,
  type ExtractedString,
} from "./binary/strings.js";
export { ByteReader, hex } from "./binary/reader.js";
export { analyzeBinary, type BinaryData } from "./analyzers/binary.js";
export { parseGoBuildInfo, type GoBuildInfo, type GoModule } from "./formats/go.js";
export { parseDotnet, type DotnetInfo, type DotnetType } from "./formats/dotnet.js";
export { parseWasm, type WasmInfo } from "./formats/wasm.js";
export {
  parseEvm,
  disassembleEvm,
  evmBytesFrom,
  EVM_OPCODES,
  type EvmInfo,
} from "./formats/evm.js";
export { parsePlist, type PlistValue } from "./formats/plist.js";
export { parseHar, type HarInfo, type HarRequest } from "./formats/har.js";
export { inspectSqlite, type SqliteInfo, type SqliteTable } from "./formats/sqlite.js";
export { openZip, type ZipArchive, type ZipEntry } from "./formats/zip.js";
export { parseAxml, type AxmlElement } from "./formats/axml.js";
export { parseApk, type ApkInfo, type ApkComponent } from "./formats/apk.js";
export { openAsar, openAsarFile, type AsarArchive, type AsarFile } from "./formats/asar.js";
export {
  scanJavaScript,
  tokenize,
  type ScanResult,
  type ModuleReference,
  type IpcUsage,
} from "./javascript/scan.js";
export {
  summarizeSourceMap,
  originalPositionFor,
  decodeVlq,
  type SourceMapSummary,
} from "./javascript/sourcemap.js";
export {
  analyzeJavaScriptTree,
  directoryTree,
  asarTree,
  type JsAppInfo,
  type JsModule,
  type JsEdge,
  type FileTree,
} from "./javascript/app.js";
export {
  analyzeTarget,
  type AnalyzeOptions,
  type AnyAnalysis,
  type AnalysisData,
  type JsScanRequest,
} from "./analyzers/dispatch.js";
export { suggestNextSteps, type NextStep } from "./next.js";
export {
  findCandidates,
  type Candidate,
  type CandidateEvidence,
  type Candidates,
} from "./javascript/candidates.js";
export type { AppCandidate, JsCoverage, JsScanFacts } from "./javascript/app.js";
export {
  Session,
  collectionsOf,
  type TargetRecord,
  type CollectionQuery,
  type CollectionPage,
  type StringsQuery,
  type CollectionComparison,
  type CompareAllResult,
} from "./session.js";
export {
  DEFAULT_PAGE_BYTES,
  MAX_PAGE_BYTES,
  MAX_PAGE_ITEMS,
  MIN_PAGE_BYTES,
  pageOf,
  reduceItem,
} from "./paging.js";
export {
  canonical,
  compareItems,
  detectKey,
  positionalFields,
  type ChangedItem,
  type CompareOptions,
  type CompareResult,
  type FieldChange,
  type SideCoverage,
  type UnknownItem,
} from "./compare.js";
export { brief, compact, type CompactOptions } from "./compact.js";
export { detectProviders, PROVIDER_OPERATIONS, type ProviderStatus } from "./providers/index.js";
export {
  callersOf,
  calleesOf,
  neighborhood,
  normalizeCallGraph,
  resolveNode,
  tracePath,
  type CallGraph,
  type GraphDirection,
  type GraphEdge,
  type GraphNode,
  type Neighborhood,
  type NeighborhoodOptions,
  type PathTrace,
} from "./providers/graph.js";
export {
  killEngines,
  isAddress,
  loadCallGraph,
  type CallGraphResult,
  runProvider,
  type ProviderRequest,
  type ProviderResult,
  type ProviderName,
  type ProviderOperation,
} from "./providers/run.js";
export { parseJavaClass, parseJar, type JavaClassInfo, type JarInfo } from "./formats/java.js";
export { parseDex, descriptorToName, type DexInfo, type DexClass } from "./formats/dex.js";
export { analyzeAppBundle, isAppBundle, type BundleInfo } from "./formats/bundle.js";
export { detectToolchain, type ToolchainFacts } from "./formats/toolchain.js";
export { readVersionInfo, type PeVersionInfo } from "./formats/peResources.js";
export {
  analyzeInWorker,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  type WorkerOptions,
} from "./analyzers/worker.js";
export {
  analyzeBundle,
  type JsBundleInfo,
  type BundleModule,
  type BundleCandidate,
  type Bundler,
} from "./javascript/bundle.js";
export {
  recoverBundle,
  recoverSourceMap,
  safeRelativePath,
  type RecoveryResult,
  type RecoveredFile,
} from "./javascript/recover.js";
export {
  parseObjcMetadata,
  type ObjcMetadata,
  type ObjcClass,
  type ObjcMethod,
  type ObjcProtocol,
} from "./formats/machoObjc.js";
export {
  demangleSwift,
  demangleSwiftClassName,
  isSwiftSymbol,
  type SwiftSymbol,
} from "./formats/swiftDemangle.js";
export { UnknownsLedger, type Unknown } from "./unknowns.js";
export { parseArsc, type ArscInfo, type ArscEntry } from "./formats/arsc.js";
export {
  summarizeFlutter,
  inspectDartLibrary,
  readDartSnapshotHeader,
  type FlutterInfo,
  type DartSnapshot,
} from "./formats/flutter.js";
export {
  decodeMethodBody,
  type CilBody,
  type CilInstruction,
  type CilResolver,
} from "./formats/cil.js";
export {
  cacheRoot,
  cacheEntries,
  cacheLimits,
  pruneCache,
  type CacheEntry,
  type PruneResult,
} from "./cache.js";
