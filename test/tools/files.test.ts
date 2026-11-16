import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as files from "../../src/tools/files.ts";
import { plain } from "../plain.ts";
import { MESSAGE_MAX_BYTES } from "../../src/kernel/derive.ts";

const read = async (...a: Parameters<typeof files.read>) => plain(await files.read(...a));
const write = async (...a: Parameters<typeof files.write>) => plain(await files.write(...a));
const edit = async (...a: Parameters<typeof files.edit>) => plain(await files.edit(...a));

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tau-files-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

describe("read", () => {
  test("numbers every line", async () => {
    const p = await file("r1.txt", "a\nb\nc\n");
    const r = await read({ path: p }, dir);
    assert.deepEqual(r, { text: "     1\ta\n     2\tb\n     3\tc", isError: false });
  });

  test("offset and limit select a range", async () => {
    const p = await file("r2.txt", "a\nb\nc\nd\n");
    assert.equal((await read({ path: p, offset: 2, limit: 1 }, dir)).text, "     2\tb");
    assert.equal((await read({ path: p, offset: 3 }, dir)).text, "     3\tc\n     4\td");
    assert.equal((await read({ path: p, limit: 2 }, dir)).text, "     1\ta\n     2\tb");
  });

  test("file without trailing newline has the same lines", async () => {
    const p = await file("r3.txt", "a\nb");
    assert.equal((await read({ path: p }, dir)).text, "     1\ta\n     2\tb");
  });

  test("CRLF line endings are stripped", async () => {
    const p = await file("r4.txt", "a\r\nb\r\n");
    assert.equal((await read({ path: p }, dir)).text, "     1\ta\n     2\tb");
  });

  test("empty file is not an error", async () => {
    const p = await file("r5.txt", "");
    const r = await read({ path: p }, dir);
    assert.equal(r.isError, false);
    assert.match(r.text, /为空/);
  });

  test("offset past the end is not an error and reports line count", async () => {
    const p = await file("r6.txt", "a\nb\n");
    const r = await read({ path: p, offset: 5 }, dir);
    assert.equal(r.isError, false);
    assert.match(r.text, /共 2 行/);
  });

  test("missing file is an error", async () => {
    const r = await read({ path: path.join(dir, "nope.txt") }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /nope\.txt/);
  });

  test("directory is an error", async () => {
    const sub = path.join(dir, "readdir");
    await mkdir(sub);
    const r = await read({ path: sub }, dir);
    assert.equal(r.isError, true);
  });

  test("relative path resolves against workdir", async () => {
    await file("rel-read.txt", "x\n");
    assert.equal((await read({ path: "rel-read.txt" }, dir)).text, "     1\tx");
  });
});

describe("write", () => {
  test("creates nested directories and writes exactly", async () => {
    const r = await write({ path: "w/x/y/z.txt", content: "hi\r\n" }, dir);
    assert.equal(r.isError, false);
    assert.match(r.text, /已写入 4 字节/);
    assert.equal(await readFile(path.join(dir, "w/x/y/z.txt"), "utf8"), "hi\r\n");
  });

  test("overwrites an existing file", async () => {
    const p = await file("w-over.txt", "old content");
    const r = await write({ path: p, content: "new" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(p, "utf8"), "new");
  });

  test("counts bytes, not characters", async () => {
    const r = await write({ path: "w-utf8.txt", content: "中" }, dir);
    assert.match(r.text, /已写入 3 字节/);
  });

  test("relative path resolves against workdir", async () => {
    await write({ path: "w-rel.txt", content: "rel" }, dir);
    assert.equal(await readFile(path.join(dir, "w-rel.txt"), "utf8"), "rel");
  });
});

describe("edit", () => {
  test("replaces a unique occurrence", async () => {
    const p = await file("e1.txt", "hello world");
    const r = await edit({ path: p, old: "world", new: "tau" }, dir);
    assert.deepEqual(r, { text: `已替换 1 处：${p}`, isError: false });
    assert.equal(await readFile(p, "utf8"), "hello tau");
  });

  test("not found is an error and file is unchanged", async () => {
    const p = await file("e2.txt", "abc");
    const r = await edit({ path: p, old: "xyz", new: "1" }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /没找到原文/);
    assert.equal(await readFile(p, "utf8"), "abc");
  });

  test("multiple matches without replaceAll is an error and file is unchanged", async () => {
    const p = await file("e3.txt", "a-a-a");
    const r = await edit({ path: p, old: "a", new: "b" }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /3 次/);
    assert.equal(await readFile(p, "utf8"), "a-a-a");
  });

  test("replaceAll replaces every non-overlapping occurrence", async () => {
    const p = await file("e4.txt", "aaaa");
    const r = await edit({ path: p, old: "aa", new: "b", replaceAll: true }, dir);
    assert.equal(r.isError, false);
    assert.match(r.text, /已替换 2 处/);
    assert.equal(await readFile(p, "utf8"), "bb");
  });

  test("new text is inserted literally ($& and $1)", async () => {
    const p = await file("e5.txt", "X");
    const r = await edit({ path: p, old: "X", new: "[$&][$1][$$]" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(p, "utf8"), "[$&][$1][$$]");
  });

  test("empty old is an error", async () => {
    const p = await file("e6.txt", "abc");
    const r = await edit({ path: p, old: "", new: "x", replaceAll: true }, dir);
    assert.equal(r.isError, true);
    assert.equal(await readFile(p, "utf8"), "abc");
  });

  test("missing file is an error, not a throw", async () => {
    const r = await edit({ path: path.join(dir, "missing-edit.txt"), old: "a", new: "b" }, dir);
    assert.equal(r.isError, true);
  });

  test("matching is exact: whitespace is not normalized", async () => {
    const p = await file("e7.txt", "a \nb");
    const r = await edit({ path: p, old: "a\nb", new: "x" }, dir);
    assert.equal(r.isError, true);
  });

  test("relative path resolves against workdir", async () => {
    await file("e-rel.txt", "one");
    const r = await edit({ path: "e-rel.txt", old: "one", new: "two" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(path.join(dir, "e-rel.txt"), "utf8"), "two");
  });
});

describe("encoding and line endings", () => {
  const gbk = Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a, 0x41, 0x3d, 0x31, 0x0d, 0x0a]);

  test("edit refuses a GBK file and leaves bytes unchanged", async () => {
    const p = await file("gbk-edit.txt", gbk);
    const r = await edit({ path: p, old: "A=1", new: "A=2" }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /不是 UTF-8 文本，不能编辑/);
    assert.deepEqual(await readFile(p), gbk);
  });

  test("edit refuses a UTF-16LE file with BOM and leaves bytes unchanged", async () => {
    const buf = Buffer.from("﻿abc", "utf16le");
    const p = await file("u16-edit.txt", buf);
    const r = await edit({ path: p, old: "abc", new: "x" }, dir);
    assert.equal(r.isError, true);
    assert.deepEqual(await readFile(p), buf);
  });

  test("read refuses a GBK file", async () => {
    const p = await file("gbk-read.txt", gbk);
    const r = await read({ path: p }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /不是 UTF-8 文本：/);
  });

  test("edit keeps a UTF-8 BOM", async () => {
    const p = await file("bom-edit.txt", "﻿hello\n");
    const r = await edit({ path: p, old: "hello", new: "hi" }, dir);
    assert.equal(r.isError, false);
    assert.deepEqual(await readFile(p), Buffer.from("﻿hi\n", "utf8"));
  });

  test("multi-line edit on a CRLF file keeps CRLF everywhere", async () => {
    const p = await file("crlf-multi.txt", "a\r\nb\r\nc\r\n");
    const r = await edit({ path: p, old: "a\nb", new: "x\ny" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(p, "utf8"), "x\r\ny\r\nc\r\n");
  });

  test("single-line edit with \\n in new writes CRLF on a CRLF file", async () => {
    const p = await file("crlf-single.txt", "a\r\nb\r\n");
    const r = await edit({ path: p, old: "a", new: "x\ny" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(p, "utf8"), "x\r\ny\r\nb\r\n");
  });

  test("CRLF file: multi-line old found twice still needs uniqueness", async () => {
    const p = await file("crlf-dup.txt", "a\r\nb\r\na\r\nb\r\n");
    const r = await edit({ path: p, old: "a\nb", new: "x" }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /2 次/);
    assert.equal(await readFile(p, "utf8"), "a\r\nb\r\na\r\nb\r\n");
  });

  test("LF file is unaffected", async () => {
    const p = await file("lf-multi.txt", "a\nb\nc\n");
    const r = await edit({ path: p, old: "a\nb", new: "x\ny" }, dir);
    assert.equal(r.isError, false);
    assert.equal(await readFile(p, "utf8"), "x\ny\nc\n");
  });

  test("read of a ~200k line file is clipped and keeps first and last line", async () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `line${i}`);
    const p = await file("huge.txt", lines.join("\n") + "\n");
    const r = await read({ path: p }, dir);
    assert.equal(r.isError, false);
    assert.ok(Buffer.byteLength(r.text, "utf8") <= MESSAGE_MAX_BYTES);
    assert.ok(r.text.startsWith("     1\tline0\n"));
    assert.ok(r.text.endsWith("line199999"));
  });
});
