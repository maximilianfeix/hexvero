import { createHash } from "node:crypto";
import { AnalysisError } from "./model.js";
import { directoryTree } from "./javascript/app.js";

/** Bytes read for one directory digest in all; past it files count by path and size only. */
export const DIGEST_MAX_BYTES = 512 * 1024 * 1024;
/** Bytes read for one file of the digest (the analysis reads no more of one file either). */
const DIGEST_MAX_FILE_BYTES = 64 << 20;

export interface DirectoryDigest {
  sha256: string;
  /** Set when the digest does not cover every file with its bytes, with the reason. */
  partial?: string;
}

/**
 * A content digest of an app directory, which has no file digest of its own (a directory is not
 * read whole when it is opened). It covers the files the analysis lists, from the same
 * `directoryTree` with its limits on depth, file count and skipped directories, read through the
 * same reader (resolved inside the root, one descriptor, regular files only). SHA-256 over a
 * manifest in path order: each file with the SHA-256 of its bytes, the links that lead out of the
 * root by name (never followed), and the reason when the listing was cut. A file over the per-file
 * limit, or past the byte budget, counts by path and size only, and `partial` says so.
 */
export function directoryDigest(
  path: string,
  options: { maxBytes?: number; maxFiles?: number } = {},
): DirectoryDigest {
  const tree = directoryTree(
    path,
    options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  );
  const digest = createHash("sha256").update("hexvero-directory-v1\n");
  const notes: string[] = [];
  let budget = options.maxBytes ?? DIGEST_MAX_BYTES;
  for (const file of tree.files.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
    if (file.size > budget || file.size > DIGEST_MAX_FILE_BYTES) {
      digest.update(`S ${file.path}\0${file.size}\n`);
      notes.push(file.size > DIGEST_MAX_FILE_BYTES ? "a file is too large" : "the byte budget");
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = tree.read(file.path, DIGEST_MAX_FILE_BYTES);
    } catch (error) {
      if (!(error instanceof AnalysisError)) throw error;
      digest.update(`U ${file.path}\0${error.code}\n`);
      notes.push("a file could not be read");
      continue;
    }
    budget -= bytes.length;
    digest.update(`F ${file.path}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  for (const link of (tree.skippedLinks ?? []).toSorted()) digest.update(`L ${link}\n`);
  if (tree.truncated) {
    digest.update(`T ${tree.truncated}\n`);
    notes.push(tree.truncated);
  }
  const partial = [...new Set(notes)];
  return {
    sha256: digest.digest("hex"),
    ...(partial.length
      ? { partial: `the digest covers only part of the directory (${partial.join("; ")})` }
      : {}),
  };
}
