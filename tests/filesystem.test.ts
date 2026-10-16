import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalFilesystem, createMemoryFilesystem } from "../src/index.js";
import type { FileSystemBackend } from "../src/index.js";

/** 两种 backend 共用契约，避免内存测试通过而真实文件语义不一致。 */
describe.each(["memory", "local"])("%s filesystem contract", (kind) => {
  let root: string;
  let backend: FileSystemBackend;
  const signal = () => new AbortController().signal;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "enio-files-"));
    const files = {
      "docs/a.md": "第一行\nsecond needle\nlast",
      "docs/b.md": "other needle",
      ".env": "secret",
      ".git/config": "private",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const options = { writable: ["docs/**", "reports/**"] };
    backend =
      kind === "memory"
        ? createMemoryFilesystem({ ...options, files })
        : createLocalFilesystem({ ...options, root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists, reads a page and returns a full-file hash", async () => {
    const listing = await backend.ls({ path: "docs", limit: 1 }, signal());
    expect(listing.entries).toHaveLength(1);
    expect(listing.nextCursor).toBe(1);
    expect((await backend.ls({ path: "docs", cursor: 1 }, signal())).entries).toHaveLength(1);
    const page = await backend.readFile(
      { path: "docs/a.md", startLine: 2, lineCount: 1 },
      signal(),
    );
    expect(page).toMatchObject({
      content: "second needle",
      startLine: 2,
      endLine: 2,
      truncated: true,
    });
    expect(page.hash).toBe((await backend.readFile({ path: "docs/a.md" }, signal())).hash);
  });

  it("A08: blocks traversal, absolute paths, sensitive files and writes outside policy", async () => {
    for (const file of [
      "../escape",
      "/etc/passwd",
      "C:/file",
      "docs\\a.md",
      ".env",
      ".git/config",
    ]) {
      await expect(backend.readFile({ path: file }, signal())).rejects.toThrow();
    }
    await expect(
      backend.writeFile({ path: "outside.txt", content: "bad" }, signal()),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const paths = (await backend.glob({ pattern: "**" }, signal())).paths;
    expect(paths.sort()).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("A09: creates without clobbering and applies exact edits with hash preconditions", async () => {
    const created = await backend.writeFile(
      { path: "reports/result.md", content: "alpha beta" },
      signal(),
    );
    await expect(
      backend.writeFile({ path: "reports/result.md", content: "lost" }, signal()),
    ).rejects.toMatchObject({ code: "already_exists" });
    await expect(
      backend.editFile(
        { path: "reports/result.md", oldText: "alpha", newText: "new", expectedHash: "stale" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const edited = await backend.editFile(
      { path: "reports/result.md", oldText: "alpha", newText: "new", expectedHash: created.hash },
      signal(),
    );
    expect(edited.hash).not.toBe(created.hash);
    expect((await backend.readFile({ path: "reports/result.md" }, signal())).content).toBe(
      "new beta",
    );
    await expect(
      backend.editFile(
        { path: "reports/result.md", oldText: "missing", newText: "x", expectedHash: edited.hash },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "edit_mismatch" });
  });

  it("A09: rejects ambiguous edits and serializes concurrent overwrites", async () => {
    const first = await backend.writeFile(
      { path: "reports/repeat.md", content: "same same" },
      signal(),
    );
    await expect(
      backend.editFile(
        { path: first.path, oldText: "same", newText: "x", expectedHash: first.hash },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "edit_mismatch" });
    const results = await Promise.allSettled(
      ["A", "B"].map((content) =>
        backend.writeFile(
          { path: first.path, content, overwrite: true, expectedHash: first.hash },
          signal(),
        ),
      ),
    );
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("A10: bounds read output, finds literal matches and reports truncated glob results", async () => {
    await backend.writeFile({ path: "reports/large.md", content: "中".repeat(20_000) }, signal());
    const read = await backend.readFile({ path: "reports/large.md" }, signal());
    expect(read.truncated).toBe(true);
    expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(24_576);
    expect(read.content).not.toContain("�");
    expect(await backend.glob({ pattern: "docs/*.md", limit: 1 }, signal())).toMatchObject({
      truncated: true,
    });
    expect(
      (await backend.grep({ literal: "needle", pattern: "docs/**" }, signal())).matches,
    ).toHaveLength(2);
    expect(
      (await backend.grep({ literal: ".*", pattern: "docs/**" }, signal())).matches,
    ).toHaveLength(0);
  });

  it("honors cancellation before creating a file", async () => {
    await expect(
      backend.writeFile({ path: "reports/cancel.md", content: "no" }, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(backend.readFile({ path: "reports/cancel.md" }, signal())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("local filesystem specific protections", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "enio-local-"));
    outside = await mkdtemp(path.join(tmpdir(), "enio-outside-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("A08: rejects symlink reads/writes and never changes the linked target", async () => {
    await writeFile(path.join(outside, "target.txt"), "safe");
    await symlink(outside, path.join(root, "link"));
    const backend = createLocalFilesystem({ root, writable: ["**"] });
    await expect(
      backend.readFile({ path: "link/target.txt" }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      backend.writeFile({ path: "link/new.txt", content: "no" }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect((await backend.glob({ pattern: "**" }, AbortSignal.timeout(1000))).paths).toEqual([]);
    expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("safe");
  });

  it("A10: rejects binary and oversized files before returning their content", async () => {
    await writeFile(path.join(root, "binary"), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(root, "large"), "x".repeat(33));
    const backend = createLocalFilesystem({ root, maxFileBytes: 32 });
    await expect(
      backend.readFile({ path: "binary" }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "binary_file" });
    await expect(
      backend.readFile({ path: "large" }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });
});
