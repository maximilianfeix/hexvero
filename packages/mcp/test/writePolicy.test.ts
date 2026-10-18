import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "@hexvero/core";
import { createHandlers } from "../src/tools.js";
import {
  checkWritePath,
  isUserPrivateGroup,
  linkMayBeFollowed,
  verifyOpened,
} from "../src/writePolicy.js";
import { buildElf } from "../../core/test/fixtures/elf.js";

/** Creates a symlink, or returns false where the platform does not permit it (Windows without rights). */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

/** Account and group lists for isUserPrivateGroup, for the user `maxi` (uid and gid 1000). */
const sources = (over: Partial<Record<"platform" | "group" | "passwd", string>> = {}) => ({
  platform: (over.platform ?? "linux") as NodeJS.Platform,
  username: () => "maxi",
  group: () => over.group ?? "root:x:0:\nusers:x:100:maxi,anna\nmaxi:x:1000:\n",
  passwd: () =>
    over.passwd ?? "root:x:0:0::/root:/bin/sh\nmaxi:x:1000:1000::/home/maxi:/bin/bash\n",
});

/** Moves a directory away and puts a link to `to` in its place, as another process could. */
const swapDir = (dir: string, to: string) => () => {
  renameSync(dir, `${dir}.old`);
  symlinkSync(to, dir);
};

describe("MCP write policy", () => {
  let root: string;
  let outside: string;
  const saved = process.env["HEXVERO_WRITE_ROOTS"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-outside-")));
    process.env["HEXVERO_WRITE_ROOTS"] = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["HEXVERO_WRITE_ROOTS"];
    else process.env["HEXVERO_WRITE_ROOTS"] = saved;
  });

  it("allows exports and recovery inside the roots", () => {
    expect(checkWritePath(join(root, "out", "report.json"), "export")).toBe(
      join(root, "out", "report.json"),
    );
    expect(checkWritePath(join(root, "recovered"), "recover")).toBe(join(root, "recovered"));
  });

  it("refuses paths outside the roots, hidden paths, other extensions and escaping symlinks", () => {
    expect(() => checkWritePath(join(outside, "report.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "..", "x.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, ".zshrc"), "export")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, ".config", "a.json"), "export")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, ".ssh"), "recover")).toThrow(/hidden/);
    expect(() => checkWritePath(join(root, "run.sh"), "export")).toThrow(/\.json/);
    symlinkSync(outside, join(root, "link"));
    expect(() => checkWritePath(join(root, "link", "report.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "link"), "recover")).toThrow(/outside/);
  });

  it("replaces only earlier exports when overwriting", async () => {
    const target = join(root, "fixture.elf");
    writeFileSync(target, buildElf());
    const session = new Session();
    const { id } = await session.open(target);
    const notes = join(root, "notes.json");
    writeFileSync(notes, '{"mine": true}');
    await expect(
      session.export(id, notes, { overwrite: true, onlyReplaceExports: true }),
    ).rejects.toThrow(/not an earlier hexvero export/);
    expect(readFileSync(notes, "utf8")).toBe('{"mine": true}');
    const report = join(root, "report.json");
    await session.export(id, report);
    await session.export(id, report, { overwrite: true, onlyReplaceExports: true });
    // an MCP export is a file, never a stream, whatever the write policy said
    for (const stream of ["-", "/dev/stdout", "/dev/fd/1"])
      await expect(
        session.export(id, stream, { overwrite: true, onlyReplaceExports: true }),
      ).rejects.toThrow(/is a stream/);
    expect(readFileSync(report, "utf8").startsWith('{\n  "hexvero": 1')).toBe(true);
  });

  it("judges a dangling symlink by where it points and never writes through a link", async (ctx) => {
    const target = join(root, "fixture.elf");
    writeFileSync(target, buildElf());
    const session = new Session();
    const { id } = await session.open(target);
    const exportVia = async (path: string) =>
      session.export(id, checkWritePath(path, "export"), {
        overwrite: true,
        onlyReplaceExports: true,
      });

    // a link to a file outside the roots that does not exist yet
    const missing = join(outside, "planted.json");
    if (!trySymlink(missing, join(root, "dangling.json"))) return ctx.skip();
    expect(() => checkWritePath(join(root, "dangling.json"), "export")).toThrow(/outside/);
    await expect(exportVia(join(root, "dangling.json"))).rejects.toThrow(/outside/);
    expect(existsSync(missing)).toBe(false);

    // a link to an existing file outside the roots
    const existing = join(outside, "existing.json");
    writeFileSync(existing, '{"keep": true}');
    trySymlink(existing, join(root, "existing.json"));
    await expect(exportVia(join(root, "existing.json"))).rejects.toThrow(/outside/);
    expect(readFileSync(existing, "utf8")).toBe('{"keep": true}');

    // a dangling link inside a linked directory chain that leaves the roots
    trySymlink(join(outside, "deeper"), join(root, "dir"));
    expect(() => checkWritePath(join(root, "dir", "a.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "dir"), "recover")).toThrow(/outside/);

    // a link that stays inside the roots passes the policy, but the export still refuses it
    trySymlink(join(root, "real.json"), join(root, "inside.json"));
    expect(checkWritePath(join(root, "inside.json"), "export")).toBe(join(root, "inside.json"));
    await expect(exportVia(join(root, "inside.json"))).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(root, "real.json"))).toBe(false);
    expect(lstatSync(join(root, "inside.json")).isSymbolicLink()).toBe(true);

    // a link that points at a hidden file inside a root
    trySymlink(join(root, ".zshrc"), join(root, "rc.json"));
    expect(() => checkWritePath(join(root, "rc.json"), "export")).toThrow(/hidden|\.json/);
  });

  it("resolves `..` in a link target against the real directory, follows chains, bounds loops", (ctx) => {
    // link targets are built with `sep`: path.join would remove the `..` as text
    mkdirSync(join(outside, "deep", "inner"), { recursive: true });
    mkdirSync(join(outside, "deep", "existing"));
    // `hop` leads out; `hop/..` is outside/deep on disk, but the root as text
    if (!trySymlink(join(outside, "deep", "inner"), join(root, "hop"))) return ctx.skip();
    trySymlink(["hop", "..", "escape.json"].join(sep), join(root, "a.json"));
    trySymlink(["hop", "..", "existing"].join(sep), join(root, "out"));
    expect(() => checkWritePath(join(root, "a.json"), "export")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "out"), "recover")).toThrow(/outside/);
    expect(() => checkWritePath(join(root, "out", "x.json"), "export")).toThrow(/outside/);

    // `..` inside the root through a linked directory that stays inside it
    mkdirSync(join(root, "real", "sub"), { recursive: true });
    trySymlink(join(root, "real", "sub"), join(root, "s"));
    trySymlink(["s", "..", "target"].join(sep), join(root, "in"));
    expect(checkWritePath(join(root, "in"), "recover")).toBe(join(root, "in"));

    // a chain of links: judged by its end
    trySymlink("l2", join(root, "l1"));
    trySymlink("l3", join(root, "l2"));
    trySymlink(join(outside, "chain"), join(root, "l3"));
    expect(() => checkWritePath(join(root, "l1"), "recover")).toThrow(/outside/);
    trySymlink("m2", join(root, "m1"));
    trySymlink(join(root, "real"), join(root, "m2"));
    expect(checkWritePath(join(root, "m1", "r.json"), "export")).toBe(join(root, "m1", "r.json"));

    // a loop is refused, not followed for ever
    trySymlink("y", join(root, "x"));
    trySymlink("x", join(root, "y"));
    expect(() => checkWritePath(join(root, "x", "r.json"), "export")).toThrow(/too many/);

    // `..` below a component that does not exist cannot be resolved
    trySymlink(["missing", "..", "..", "up.json"].join(sep), join(root, "up.json"));
    expect(() => checkWritePath(join(root, "up.json"), "export")).toThrow(/missing directory/);
  });

  it("refuses to recover into a dangling symlink with invalid_input", async (ctx) => {
    const bundle = join(root, "bundle.js");
    writeFileSync(bundle, "console.log(1);\n");
    const session = new Session();
    const { id } = await session.open(bundle);
    if (!trySymlink(join(root, "not-there"), join(root, "out"))) return ctx.skip();
    expect(checkWritePath(join(root, "out"), "recover")).toBe(join(root, "out"));
    await expect(session.recover(id, join(root, "out"))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(existsSync(join(root, "not-there"))).toBe(false);
  });

  it("compares paths in their stored case on a case-insensitive volume", (ctx) => {
    const name = root.split(sep).pop()!;
    const shouted = join(root, "..", name.toUpperCase());
    if (name === name.toUpperCase() || !existsSync(shouted)) return ctx.skip(); // case-sensitive
    expect(checkWritePath(join(shouted, "a.json"), "export")).toBe(join(shouted, "a.json"));
    mkdirSync(join(root, "Sub"));
    expect(checkWritePath(join(shouted, "SUB", "a.json"), "export")).toBe(
      join(shouted, "SUB", "a.json"),
    );
  });

  describe("between the check and the write", () => {
    /** A session whose next analysis also swaps a directory, as another process could meanwhile. */
    class SwapSession extends Session {
      swap: (() => void) | undefined;
      override async analyze(...args: Parameters<Session["analyze"]>) {
        const result = await super.analyze(...args);
        const swap = this.swap;
        this.swap = undefined;
        swap?.();
        return result;
      }
    }

    it("refuses an export and a recovery when a directory became a link", async (ctx) => {
      const victim = join(outside, "victim");
      mkdirSync(victim);
      if (!trySymlink(victim, join(root, "probe"))) return ctx.skip();
      const session = new SwapSession();
      const tools = createHandlers(session, {} as never);
      const elf = join(root, "fixture.elf");
      writeFileSync(elf, buildElf());
      const { id } = await session.open(elf);
      mkdirSync(join(root, "d"));
      session.swap = swapDir(join(root, "d"), victim);
      await expect(
        tools.hexvero_export({ targetId: id, path: join(root, "d", "out.json") }),
      ).rejects.toThrow(/outside/);
      expect(existsSync(join(victim, "out.json"))).toBe(false);

      const bundle = join(root, "bundle.js");
      writeFileSync(bundle, "console.log(1);\n");
      const js = await session.open(bundle);
      mkdirSync(join(root, "e"));
      session.swap = swapDir(join(root, "e"), victim);
      await expect(
        tools.hexvero_recover({ targetId: js.id, outputDir: join(root, "e", "rec") }),
      ).rejects.toThrow(/outside/);
      expect(existsSync(join(victim, "rec"))).toBe(false);
    });

    it("removes a recovered file opened after a swap, before writing to it", async (ctx) => {
      const victim = join(outside, "victim3");
      mkdirSync(victim);
      if (!trySymlink(victim, join(root, "probe3"))) return ctx.skip();
      const bundle = join(root, "bundle3.js");
      writeFileSync(bundle, "console.log(1);\n");
      const session = new Session();
      const { id } = await session.open(bundle);
      const out = join(root, "rec3");
      let swapped = false;
      await expect(
        session.recover(id, out, {
          // the policy holds when checked; then the directory is swapped before the open
          guard: (path) => {
            checkWritePath(path, "recover");
            if (!swapped && path.startsWith(out + sep) && path.endsWith(".json")) {
              swapped = true;
              swapDir(out, victim)();
            }
          },
          check: (path, opened) => verifyOpened(path, "recover", opened),
        }),
      ).rejects.toThrow(/outside/);
      expect(swapped).toBe(true);
      expect(readdirSync(victim)).toEqual([]);
    });

    it("refuses an opened file that is not the one the policy resolved", async (ctx) => {
      const victim = join(outside, "victim2");
      mkdirSync(victim);
      mkdirSync(join(root, "f"));
      const path = join(root, "f", "x.json");
      writeFileSync(path, "{}");
      const opened = statSync(path);
      expect(() => verifyOpened(path, "export", opened)).not.toThrow();
      writeFileSync(join(victim, "x.json"), "{}");
      if (!trySymlink(victim, join(root, "probe2"))) return ctx.skip();
      swapDir(join(root, "f"), join(root, "g"))();
      mkdirSync(join(root, "g"));
      writeFileSync(join(root, "g", "x.json"), "{}");
      expect(() => verifyOpened(path, "export", opened)).toThrow(/changed while it was opened/);
    });

    it("refuses directories other users can change, unless they are sticky", (ctx) => {
      if (process.getuid === undefined) return ctx.skip();
      const shared = join(root, "shared");
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      expect(() => checkWritePath(join(shared, "a.json"), "export")).toThrow(/other users/);
      chmodSync(shared, 0o1777);
      expect(checkWritePath(join(shared, "a.json"), "export")).toBe(join(shared, "a.json"));
      chmodSync(shared, 0o755);
      expect(checkWritePath(join(shared, "a.json"), "export")).toBe(join(shared, "a.json"));
      // group-writable: refused unless the group is provably the user's own (Linux only)
      const own = join(root, "own-group");
      mkdirSync(join(own, "sub"), { recursive: true });
      chmodSync(own, 0o775);
      if (!isUserPrivateGroup(statSync(own).gid))
        expect(() => checkWritePath(join(own, "sub", "a.json"), "export")).toThrow(/other users/);
      // macOS: the primary group is the shared `staff`, never exempt
      if (process.platform === "darwin")
        expect(() => checkWritePath(join(own, "sub", "a.json"), "export")).toThrow(/other users/);
      // the explicit opt-in for setups the check cannot prove
      process.env["HEXVERO_TRUST_GROUP_WRITABLE"] = "1";
      try {
        expect(checkWritePath(join(own, "sub", "a.json"), "export")).toBe(
          join(own, "sub", "a.json"),
        );
      } finally {
        delete process.env["HEXVERO_TRUST_GROUP_WRITABLE"];
      }
      chmodSync(own, 0o755);
      // writable by another group: any member of it could swap an entry
      const other = process.getgroups!().find((g) => g !== process.getgid!());
      if (other === undefined) return; // no second group to test with
      const group = join(root, "group");
      mkdirSync(join(group, "sub"), { recursive: true });
      chownSync(group, process.getuid(), other);
      chmodSync(group, 0o775);
      expect(() => checkWritePath(join(group, "sub", "a.json"), "export")).toThrow(/other users/);
      expect(() => checkWritePath(join(group, "rec"), "recover")).toThrow(/other users/);
      chmodSync(group, 0o755);
      expect(checkWritePath(join(group, "rec"), "recover")).toBe(join(group, "rec"));
      // an ancestor of the root counts too
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "hexvero-parent-")));
      mkdirSync(join(parent, "r"));
      process.env["HEXVERO_WRITE_ROOTS"] = join(parent, "r");
      expect(checkWritePath(join(parent, "r", "a.json"), "export")).toBe(
        join(parent, "r", "a.json"),
      );
      chownSync(parent, process.getuid(), other);
      chmodSync(parent, 0o775);
      expect(() => checkWritePath(join(parent, "r", "a.json"), "export")).toThrow(/other users/);
      chmodSync(parent, 0o700);
    });
  });

  it("exempts only a provable Linux user-private group", () => {
    expect(isUserPrivateGroup(1000, sources())).toBe(true);
    expect(isUserPrivateGroup(1000, sources({ group: "maxi:x:1000:maxi\n" }))).toBe(true);
    // never on macOS or Windows
    expect(isUserPrivateGroup(1000, sources({ platform: "darwin" }))).toBe(false);
    expect(isUserPrivateGroup(1000, sources({ platform: "win32" }))).toBe(false);
    // a shared group, another member, a system gid, an unknown gid
    expect(isUserPrivateGroup(100, sources())).toBe(false);
    expect(isUserPrivateGroup(1000, sources({ group: "maxi:x:1000:anna\n" }))).toBe(false);
    expect(isUserPrivateGroup(1000, sources({ group: "staff:x:1000:\n" }))).toBe(false);
    expect(isUserPrivateGroup(500, sources({ group: "maxi:x:500:\n" }))).toBe(false);
    expect(isUserPrivateGroup(1001, sources())).toBe(false);
    // another account with that gid as its primary group, or a second entry for the gid
    expect(
      isUserPrivateGroup(
        1000,
        sources({ passwd: "maxi:x:1000:1000::/h:/s\nanna:x:1001:1000::/h:/s\n" }),
      ),
    ).toBe(false);
    expect(isUserPrivateGroup(1000, sources({ group: "maxi:x:1000:\ndev:x:1000:anna\n" }))).toBe(
      false,
    );
    // unreadable lists
    expect(
      isUserPrivateGroup(1000, {
        ...sources(),
        group: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(false);
  });

  it("follows another user's link in a sticky directory only when root owns it", (ctx) => {
    // the rule, with uids that a test cannot create links as
    expect(linkMayBeFollowed(1001, 0o41777, 1000)).toBe(false);
    expect(linkMayBeFollowed(1000, 0o41777, 1000)).toBe(true);
    expect(linkMayBeFollowed(0, 0o41777, 1000)).toBe(true);
    expect(linkMayBeFollowed(1001, 0o40755, 1000)).toBe(true);
    expect(linkMayBeFollowed(1001, 0o41777, null)).toBe(true);
    // your own link in a sticky directory is still followed
    const shared = join(root, "sticky");
    mkdirSync(join(shared, "real"), { recursive: true });
    if (!trySymlink(join(shared, "real"), join(shared, "mine"))) return ctx.skip();
    chmodSync(shared, 0o1777);
    expect(checkWritePath(join(shared, "mine", "a.json"), "export")).toBe(
      join(shared, "mine", "a.json"),
    );
    chmodSync(shared, 0o755);
  });
});
