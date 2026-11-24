import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, truncate, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as files from "../../src/tools/files.ts";
import { plain } from "../plain.ts";
import { noted } from "../../src/tools/args.ts";
import { MESSAGE_MAX_BYTES } from "../../src/kernel/derive.ts";
import { checkImages, IMAGE_MAX_BYTES } from "../../src/images.ts";
import { IMAGE_UNSUPPORTED } from "../../src/kernel/context.ts";
import { BLOB_PREFIX } from "../../src/store/blobs.ts";
import { gif, png } from "../images.ts";

// 和执行器一样：文件工具把兜底的说明收进数组，再由 noted 接在结果最后（D109）。
const slash = (p: string): string => p.replaceAll("\\", "/");
const read = async (a: { path: string; offset?: number; limit?: number }, w: string, accepts = true) => {
  const notes: string[] = [];
  return plain(noted(await files.read(a, w, accepts, notes), notes));
};
const write = async (a: Parameters<typeof files.write>[0], w: string) => {
  const notes: string[] = [];
  return plain(noted(await files.write(a, w, notes), notes));
};
const edit = async (a: Parameters<typeof files.edit>[0], w: string) => {
  const notes: string[] = [];
  return plain(noted(await files.edit(a, w, notes), notes));
};

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

  test("超大文本文件在 stat 后直接拒绝，不整份读入内存", async () => {
    const p = await file("huge.log", "hello\n");
    await truncate(p, files.READ_MAX_BYTES + 1);
    const r = await read({ path: p }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /不能整份读取/);
  });
});

describe("read 图片", () => {
  const out = (a: { path: string }, accepts = true) => files.read(a, dir, accepts);

  test("png 读成图片块，带要存的字节", async () => {
    const bytes = png(10, 20, 7);
    const p = await file("pic.png", bytes);
    const [im] = checkImages([bytes.toString("base64")]);
    const r = await out({ path: p });
    assert.equal(r.isError, false);
    assert.deepEqual(r.content, [{ type: "image", data: BLOB_PREFIX + im!.hash, mimeType: "image/png" }]);
    assert.equal(r.images?.length, 1);
    assert.deepEqual(r.images![0]!.bytes, bytes);
  });

  test("gif 的类型是 image/gif", async () => {
    const p = await file("pic.gif", gif(3, 4, 2));
    const r = await out({ path: p });
    assert.deepEqual(
      r.content.map((c) => c.type === "image" && c.mimeType),
      ["image/gif"],
    );
  });

  test("模型不收图片：结果是 IMAGE_UNSUPPORTED，不存图片", async () => {
    const p = await file("pic-noimg.png", png(4, 4, 5));
    const r = await out({ path: p }, false);
    assert.deepEqual(r, { content: [{ type: "text", text: IMAGE_UNSUPPORTED }], isError: false });
    assert.equal("images" in r, false);
  });

  test("超大图报错，不收图片时也是错误", async () => {
    const bytes = Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_MAX_BYTES)]);
    const p = await file("pic-big.png", bytes);
    for (const accepts of [true, false]) {
      const r = await out({ path: p }, accepts);
      assert.equal(r.isError, true);
      assert.match(String((r.content[0] as { text: string }).text), /图片不合格/);
      assert.match(String((r.content[0] as { text: string }).text), /字节/);
      assert.equal("images" in r, false);
    }
  });

  test("尺寸超限报错，报出宽高", async () => {
    const p = await file("pic-wide.png", png(2001, 10));
    const r = await out({ path: p });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /2001×10/);
  });

  test("扩展名骗人：x.txt 里是 png 字节照样当图片", async () => {
    const p = await file("x.txt", png(2, 2, 1));
    assert.deepEqual(
      (await out({ path: p })).content.map((c) => c.type),
      ["image"],
    );
  });

  test("扩展名骗人：x.png 里是文本照样当文本，带行号", async () => {
    const p = await file("x.png", "a\nb\n");
    assert.equal((await read({ path: p }, dir)).text, "     1\ta\n     2\tb");
  });

  test("非图片二进制仍报不是 UTF-8 文本", async () => {
    const p = await file("bin.dat", Buffer.from([0xff, 0xfe, 0x00]));
    const r = await out({ path: p });
    assert.equal(r.isError, true);
    assert.match((r.content[0] as { text: string }).text, /不是 UTF-8 文本/);
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
    assert.deepEqual(r, { text: `已替换 1 处：${slash(p)}`, isError: false });
    assert.equal(await readFile(p, "utf8"), "hello tau");
  });

  test("not found is an error and file is unchanged", async () => {
    const p = await file("e2.txt", "abc");
    const r = await edit({ path: p, old: "xyz", new: "1" }, dir);
    assert.equal(r.isError, true);
    assert.match(r.text, /^没找到原文：.*。old 里最长的几行，在文件里要么没有，要么不止一处/);
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

  test("行尾空白放宽，行首空白不放宽", async () => {
    const p = await file("e7.txt", "a \nb");
    const r = await edit({ path: p, old: "a\nb", new: "a\nc" }, dir);
    assert.deepEqual(r, { text: `已替换 1 处：${slash(p)}\n注：old 和文件的行尾空白不一样，按不计行尾空白找到了原文。`, isError: false });
    assert.equal(await readFile(p, "utf8"), "a \nc");
    const q = await file("e7b.txt", "  a\nb");
    assert.equal((await edit({ path: q, old: "a\nb", new: "x" }, dir)).isError, false); // 子串能找到
    const t = await file("e7c.txt", "\ta\n\tb");
    assert.equal((await edit({ path: t, old: "    a\n    b", new: "x" }, dir)).isError, true);
    assert.equal(await readFile(t, "utf8"), "\ta\n\tb");
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
    assert.ok(r.text.startsWith(`不是 UTF-8 文本，不能编辑：${slash(p)}。多半是 GBK。`), r.text);
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
    assert.ok(r.text.includes(`iconv -f GBK -t UTF-8 '${slash(p)}'`) && r.text.includes("iconv -c -f UTF-8 -t UTF-8"), r.text);
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
    assert.ok(Buffer.byteLength(r.text, "utf8") <= MESSAGE_MAX_BYTES - 1024); // 给执行器接的说明留位置
    assert.ok(r.text.startsWith("     1\tline0\n"));
    assert.ok(r.text.endsWith("line199999"));
  });
});

describe("家目录路径", () => {
  // 模型写 `~/x` 或 `~`：展开成家目录，read、write、edit 走同一个解析。
  const home = os.homedir();

  test("~/ 和 ~ 展开成家目录", async () => {
    const name = `tau-home-missing-${process.pid}.txt`;
    const file = path.join(home, name);
    const ls = `看看目录里有什么：用 bash 运行 ls '${slash(home)}'`;
    assert.deepEqual(await read({ path: `~/${name}` }, dir), { text: `读取失败：${slash(file)}（文件不存在）。${ls}`, isError: true });
    assert.deepEqual(await edit({ path: `~/${name}`, old: "a", new: "b" }, dir), { text: `编辑失败：${slash(file)}（文件不存在）。${ls}`, isError: true });
    const w = await write({ path: "~", content: "x" }, dir);
    assert.equal(w.isError, true);
    assert.equal(w.text.split("\n")[0], `写入失败：${slash(home)}（是目录；path 要写到文件名）`);
  });

  test("~、~/、~\\、$HOME 展开成家目录，/tmp 是 Git Bash 的临时目录；/home、~user 照旧按普通路径解析", async () => {
    const miss = (p: string) => `读取失败：${slash(p)}（文件不存在）。`;
    assert.ok((await read({ path: "/tmp/tau-none.txt" }, dir)).text.startsWith(miss(path.join(os.tmpdir(), "tau-none.txt"))));
    assert.ok((await read({ path: "$HOME/tau-none.txt" }, dir)).text.startsWith(miss(path.join(home, "tau-none.txt"))));
    assert.ok((await read({ path: "~\\tau-none.txt" }, dir)).text.startsWith(miss(path.join(home, "tau-none.txt"))));
    assert.equal((await read({ path: "/home/tau-none.txt" }, dir)).text.includes(slash(home)), false);
    assert.ok((await read({ path: "~user/tau-none.txt" }, dir)).text.startsWith(miss(path.resolve(dir, "~user/tau-none.txt"))));
  });
});

describe("msys drive paths", () => {
  // /c/Users/x 是 Git Bash 的写法；path.resolve 会把它当成当前盘根下的 \c\Users\x。
  const msys = (p: string): string => p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll("\\", "/");

  test("read, write and edit treat /x/… as X:/…", async () => {
    const p = msys(path.join(dir, "msys.txt"));
    assert.match(p, /^\/[a-z]\//);
    assert.equal((await write({ path: p, content: "a\nb\n" }, "C:\\elsewhere")).isError, false);
    assert.equal(await readFile(path.join(dir, "msys.txt"), "utf8"), "a\nb\n");
    assert.equal((await edit({ path: p, old: "b", new: "c" }, "C:\\elsewhere")).isError, false);
    assert.equal((await read({ path: p }, "C:\\elsewhere")).text, "     1\ta\n     2\tc");
  });

  test("a bare /x is the drive root; /xy/… and relative paths are left alone", async () => {
    const r = await read({ path: msys(path.parse(dir).root) }, "C:\\elsewhere");
    assert.match(r.text, /^是目录，不能读取：[A-Z]:\/。要看里面有什么，用 bash 运行 ls -la '[A-Z]:\/'$/);
    assert.match((await read({ path: "/ee/none.txt" }, dir)).text, /读取失败：[A-Za-z]:\/ee\/none\.txt/);
    assert.equal((await read({ path: "sub/none.txt" }, dir)).isError, true);
  });
});

describe("路径兜底（D109）", () => {
  const F = (): string => slash(dir);

  test("被 JSON 吃掉的反斜杠：\\n、\\t、\\b 还原，首尾的控制字符当空白", async () => {
    await mkdir(path.join(dir, "new"), { recursive: true });
    await writeFile(path.join(dir, "new", "tab.txt"), "x\n");
    const raw = path.join(dir, "new", "tab.txt").replace("\\new", "\new").replace("\\tab", "\tab");
    const want = `${F()}/new/tab.txt`;
    assert.deepEqual(files.fixPath(dir, raw), { file: want, notes: [`路径 ${JSON.stringify(raw)} 当作 ${want}`] });
    assert.deepEqual(await read({ path: raw }, dir), { text: `     1\tx\n注：路径 ${JSON.stringify(raw)} 当作 ${want}。`, isError: false });
    const bin = path.join(dir, "new", "bin", "f.txt").replace("\\bin", "\bin");
    assert.equal((await write({ path: bin, content: "z" }, dir)).isError, false);
    assert.equal(await readFile(path.join(dir, "new", "bin", "f.txt"), "utf8"), "z");
    assert.ok(readdirSync(path.join(dir, "new")).every((n) => !/[\x00-\x1f]/.test(n)));
    assert.equal(files.fixPath(dir, "a.txt\n").file, `${F()}/a.txt`);
    assert.equal(files.fixPath(dir, "\tmp\\x").file, `${slash(path.parse(dir).root)}tmp/x`);
  });

  test("首尾空白和成对的引号：照做并说明；a'b.txt 不动", async () => {
    await file("pq.txt", "q\n");
    for (const raw of [" pq.txt\n", '"pq.txt"', "'pq.txt'", "`pq.txt`"]) {
      assert.deepEqual(files.fixPath(dir, raw), { file: `${F()}/pq.txt`, notes: [`路径 ${JSON.stringify(raw)} 当作 ${F()}/pq.txt`] }, raw);
      assert.equal((await read({ path: raw }, dir)).text.split("\n")[0], "     1\tq", raw);
    }
    assert.deepEqual(files.fixPath(dir, "a'b.txt").notes, []);
  });

  test("斜杠后面又出现盘符：去掉前面多出的部分；不是路径的文字不截，write 拒绝", async () => {
    await file("pc.txt", "c\n");
    const d = F()[0]!.toLowerCase();
    const junk = [`/${d}/${F()}/pc.txt`, `file:///${F()}/pc.txt`, `${F()}/${F()}/pc.txt`, `\\\\?\\${dir}\\pc.txt`, `./${F()}/pc.txt`];
    for (const raw of junk) {
      const r = await read({ path: raw }, dir);
      assert.ok(r.text.startsWith("     1\tc\n注：路径 "), `${raw}：${r.text}`);
    }
    assert.equal((await write({ path: `/${d}/${F()}/w.txt`, content: "w" }, "C:\\elsewhere")).isError, false);
    assert.equal(await readFile(path.join(dir, "w.txt"), "utf8"), "w");
    for (const raw of [`${F()}/a.ts, ${F()}/b.ts`, `cat ${F()}/a.ts`, `[a](${F()}/a.ts)`]) {
      assert.equal(files.fixPath(dir, raw).file, slash(path.resolve(dir, raw)), raw);
      const w = await write({ path: raw, content: "x" }, dir);
      assert.ok(w.isError && w.text.includes("Windows 的文件名不能含"), raw);
    }
  });

  test("bash 里同义的写法不加说明；不认的写法照 path.resolve；再解析一遍结果不变", () => {
    const home = slash(os.homedir());
    assert.deepEqual(files.fixPath(dir, "/tmp/x"), { file: `${slash(os.tmpdir())}/x`, notes: [] });
    assert.equal(files.fixPath(dir, "/tmp").file, slash(os.tmpdir()));
    for (const raw of ["~\\x", "$HOME/x", "~/x"]) assert.deepEqual(files.fixPath(dir, raw), { file: `${home}/x`, notes: [] }, raw);
    const raws = ["/mnt/e/x", "/cygdrive/c/x", "/tmpx/a", "/home/x", "~user/x", "%USERPROFILE%\\x", "@a.txt"];
    for (const raw of raws) assert.deepEqual(files.fixPath(dir, raw), { file: slash(path.resolve(dir, raw)), notes: [] }, raw);
    for (const raw of [...raws, "/tmp/x", "~\\x", " a.txt", "/c/x"]) {
      const once = files.fixPath(dir, raw);
      assert.deepEqual(files.fixPath(dir, once.file), { file: once.file, notes: [] }, raw);
    }
  });

  test("rewrite 只换写法、不解析：spawn 的 workdir 用它", () => {
    const home = slash(os.homedir());
    assert.deepEqual(files.rewrite("/e/x"), { path: "E:/x", fixed: false });
    assert.deepEqual(files.rewrite("~/p"), { path: `${home}/p`, fixed: false });
    assert.deepEqual(files.rewrite("/d/D:/x"), { path: "D:/x", fixed: true });
    for (const raw of [".", "sub", "/tmp", "/", "/Windows", "E:/abs"]) assert.deepEqual(files.rewrite(raw), { path: raw, fixed: false }, raw);
  });
});

describe("read 的 offset 和 limit", () => {
  test("offset 0 当 1，limit 小于 1 当不限，都不加说明", async () => {
    const p = await file("ol.txt", "a\nb\nc\nd\n");
    assert.deepEqual(await read({ path: p, offset: 0, limit: 1 }, dir), { text: "     1\ta", isError: false });
    assert.equal((await read({ path: p, offset: 2, limit: 0 }, dir)).text, "     2\tb\n     3\tc\n     4\td");
    assert.equal((await read({ path: p, limit: -1 }, dir)).text, "     1\ta\n     2\tb\n     3\tc\n     4\td");
  });

  test("负 offset 是错误，文字给算好的 offset", async () => {
    const p = await file("ol2.txt", "a\nb\nc\nd\n");
    assert.deepEqual(await read({ path: p, offset: -2 }, dir), { text: `offset 从 1 计，不能是 -2：${slash(p)}。文件共 4 行，要看最后 2 行，用 offset=3。`, isError: true });
    assert.ok((await read({ path: p, offset: -9 }, dir)).text.endsWith("用 offset=1。"));
  });
});

describe("不是 UTF-8 时给能照抄的命令", () => {
  const bash = (): string => {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && existsSync(path.join(d, "git.exe")));
    return dirs.flatMap((d) => [d, path.dirname(d), path.dirname(path.dirname(d))]).map((r) => path.join(r, "bin", "bash.exe")).find((p) => existsSync(p))!;
  };

  test("UTF-16、二进制、GBK 各给各的，文件字节不变", async () => {
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf16le")]);
    const p = await file("nu16.txt", u16);
    const f = slash(p);
    assert.ok((await read({ path: p }, dir)).text.includes(`iconv -f UTF-16LE -t UTF-8 '${f}'`));
    const e = (await edit({ path: p, old: "a", new: "b" }, dir)).text;
    assert.ok(e.includes(`> '${f}.utf8' || rm '${f}.utf8'`) && e.includes(`&& mv '${f}.new' '${f}'`), e);
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const q = await file("nbin.dat", bin);
    const r = (await read({ path: q }, dir)).text;
    assert.ok(r.includes("不能当文本读") && r.includes(`file '${slash(q)}'`), r);
    assert.ok((await edit({ path: q, old: "a", new: "b" }, dir)).text.includes("不能当文本编辑"));
    assert.deepEqual([await readFile(p), await readFile(q)], [u16, bin]);
  });

  test("edit 的三步照抄走得通：转出副本、用 edit 改副本、转回；原文件只在最后一步才变", async () => {
    const gbk = Buffer.from("A=你好\r\nB=1\r\n", "latin1"); // 占位，下面换成真的 GBK 字节
    const bytes = Buffer.from([0x41, 0x3d, 0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a, 0x42, 0x3d, 0x31, 0x0d, 0x0a]);
    const p = await file("rt.ini", bytes);
    const f = slash(p);
    const text = (await edit({ path: p, old: "B=1", new: "B=2" }, dir)).text;
    const steps = text.slice(text.indexOf("：iconv") + 1).split("；"); // 第 1 步、“用 edit 改副本”、第 3 步
    const run = (cmd: string): string => execFileSync(bash(), ["-c", cmd], { encoding: "utf8", cwd: dir });
    run(steps[0]!);
    assert.deepEqual(await readFile(p), bytes);
    assert.equal((await edit({ path: `${p}.utf8`, old: "B=1", new: "B=2" }, dir)).isError, false);
    run(steps[2]!.replace(/^再转回原文件：/, ""));
    assert.deepEqual(await readFile(p), Buffer.from([0x41, 0x3d, 0xc4, 0xe3, 0xba, 0xc3, 0x0d, 0x0a, 0x42, 0x3d, 0x32, 0x0d, 0x0a]));
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("rt.ini")), ["rt.ini"]);
    assert.ok(steps[0]!.includes(`'${f}'`));
  });

  test("UTF-16 文件照抄三步，字节序不变：LE 回 LE，BE 回 BE，只有改的那处变（T3）", async () => {
    const swap = (b: Buffer): Buffer => Buffer.from(b).swap16();
    for (const [name, bom, enc] of [["u16le.reg", [0xff, 0xfe], "UTF-16LE"], ["u16be.reg", [0xfe, 0xff], "UTF-16BE"]] as const) {
      const body = (t: string): Buffer => (enc === "UTF-16LE" ? Buffer.from(t, "utf16le") : swap(Buffer.from(t, "utf16le")));
      const before = Buffer.concat([Buffer.from(bom), body("A=1\r\nB=1\r\n")]);
      const p = await file(name, before);
      const text = (await edit({ path: p, old: "B=1", new: "B=2" }, dir)).text;
      assert.ok(text.includes(`iconv -f ${enc} -t UTF-8 `) && text.includes(`iconv -f UTF-8 -t ${enc} `), text);
      const steps = text.slice(text.indexOf("：iconv") + 1).split("；");
      const run = (cmd: string): string => execFileSync(bash(), ["-c", cmd], { encoding: "utf8", cwd: dir });
      run(steps[0]!);
      assert.equal((await edit({ path: `${p}.utf8`, old: "B=1", new: "B=2" }, dir)).isError, false);
      run(steps[2]!.replace(/^再转回原文件：/, ""));
      assert.deepEqual(await readFile(p), Buffer.concat([Buffer.from(bom), body("A=1\r\nB=2\r\n")]), name);
      assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(name)), [name]);
    }
  });
});

describe("write 的文件名和错误文字", () => {
  test("含 Windows 不许的字符、以点或空格结尾：拒绝；.env 照常写", async () => {
    for (const name of ["notes 12:30.md", "r-2026-11-24T12:30:00.md", "src/*.ts", "a.txt.", "dir./x.txt", "sp /y.txt"]) {
      const r = await write({ path: name, content: "x" }, dir);
      assert.ok(r.isError && r.text.includes("Windows 的文件名不能含"), name);
    }
    const names = readdirSync(dir);
    for (const n of ["notes 12", "a.txt.", "dir.", "sp "]) assert.equal(names.includes(n), false, n);
    assert.equal((await write({ path: ".env", content: "x" }, dir)).isError, false);
    assert.equal((await write({ path: "x/.gitignore", content: "x" }, dir)).isError, false);
  });

  test("文件不存在给 ls（路径里的撇号写成 '\\''），读目录给 ls -la，写到目录说明 path 要写到文件名", async () => {
    const sub = path.join(dir, "Bob's");
    await mkdir(sub, { recursive: true });
    const r = await read({ path: path.join(sub, "none.txt") }, dir);
    assert.ok(r.text.endsWith(`ls '${slash(dir)}/Bob'\\''s'`), r.text);
    assert.ok((await read({ path: sub }, dir)).text.includes("ls -la '"));
    assert.ok((await write({ path: sub, content: "x" }, dir)).text.includes("（是目录；path 要写到文件名）"));
  });

  test("文件被占着或只读：说下一步，不再给 Node 的英文原文", async () => {
    const p = await file("ro.txt", "a");
    chmodSync(p, 0o444);
    try {
      const w = await write({ path: p, content: "b" }, dir);
      assert.ok(w.isError && w.text.includes("：文件被别的程序占着，或者是只读的、没有权限。换个文件名写，或者告诉用户）"), w.text);
    } finally {
      chmodSync(p, 0o666);
    }
  });
});

describe("edit 兜底（D109）", () => {
  let n = 0;
  const tmp = (content: string): Promise<string> => file(`g${n++}.txt`, content);
  const ed = (a: Parameters<typeof files.edit>[0]) => edit(a, dir);
  const body = (p: string) => readFile(p, "utf8");
  const NUM = "\n注：old 每行开头带着 read 加的行号，已去掉，new 里有的也去掉了。";
  const WS = "\n注：old 和文件的行尾空白不一样，按不计行尾空白找到了原文。";
  async function ok(content: string, a: { old: string; new: string; replaceAll?: boolean }, want: string, note?: string) {
    const p = await tmp(content);
    const r = await ed({ path: p, ...a });
    assert.equal(r.isError, false, r.text);
    assert.equal(await body(p), want);
    if (note === undefined) assert.doesNotMatch(r.text, /注：/);
    else assert.ok(r.text.endsWith(note), r.text);
    return r;
  }
  async function bad(content: string, a: { old: string; new: string; replaceAll?: boolean }) {
    const p = await tmp(content);
    const r = await ed({ path: p, ...a });
    assert.equal(r.isError, true, r.text);
    assert.equal(await body(p), content);
    return r;
  }

  describe("old 带 read 的行号前缀", () => {
    test("单行、多行、插入的行不带前缀、CRLF", async () => {
      await ok("a\nb\nc\n", { old: "     2\tb", new: "B" }, "a\nB\nc\n", NUM);
      await ok("a\nb\nc\n", { old: "     1\ta\n     2\tb", new: "     1\tA\n     2\tB" }, "A\nB\nc\n", NUM);
      await ok("x\ny\nz\n", { old: "     1\tx\n     2\ty", new: "     1\tx\ninserted\n     2\ty" }, "x\ninserted\ny\nz\n", NUM);
      await ok("a\r\nb\r\nc\r\n", { old: "     1\ta\n     2\tb", new: "     1\tA\n     2\tB" }, "A\r\nB\r\nc\r\n", NUM);
    });
    test("空行的三种写法", async () => {
      await ok("p\n\nq\n\nr\n\ns\n", { old: "     1\tp\n     2\t\n     3\tq\n     4\n     5\tr\n\n     7\ts", new: "P" }, "P\n", NUM);
    });
    test("不认的写法：行号不连续、去了前导空格", async () => {
      await bad("x\ny\nz\n", { old: "     1\tx\n     3\tz", new: "q" });
      const r = await bad("a\nb\nc\n", { old: "2\tb", new: "B" });
      assert.match(r.text, /最像的是第 2 行。/);
      assert.ok(r.text.endsWith("\n     2\tb"), r.text);
    });
    test("内容开头是数字：new 里不是 read 样子、或不在附近的数字不去", async () => {
      await ok("600519\t贵州茅台\n000001\t平安银行\n", { old: "     2\t000001\t平安银行", new: "000001\t平安银行股份" }, "600519\t贵州茅台\n000001\t平安银行股份\n", NUM);
      await ok("600519\n000001\n300750\n", { old: "     1\t600519\n     2\t000001", new: "600519\n000001\n601318" }, "600519\n000001\n601318\n300750\n", NUM);
      await ok("SIZES = [\n    16,\n    32\n]\n", { old: "     2\t    16,\n     3\t    32", new: "     2\t    16,\n     3\t    32,\n    64" }, "SIZES = [\n    16,\n    32,\n    64\n]\n", NUM);
      await ok("1\tAlice\t30\n2\tBob\t25\n", { old: "     2\t2\tBob\t25", new: "2\tBob\t26" }, "1\tAlice\t30\n2\tBob\t26\n", NUM);
    });
    test("new 里从远处抄来的带前缀的行也去掉", async () => {
      await ok("a\nb\nc\n", { old: "     2\tb", new: "     2\tb\n    50\tfar" }, "a\nb\nfar\nc\n", NUM);
    });
    test("原样能找到就不去：cat -n 的文件、6 位编号的 TSV", async () => {
      await ok("     1\tfoo\n     2\tbar\n", { old: "     2\tbar", new: "     2\tBAR" }, "     1\tfoo\n     2\tBAR\n");
      const r = await ok("123456\tfoo\n", { old: "123456\tfoo  ", new: "654321\tbar" }, "654321\tbar\n", WS);
      assert.doesNotMatch(r.text, /行号/);
    });
    test("去掉以后只剩空白：不去，不改文件", async () => {
      await bad("a\nb\nc\n\nd\n", { old: "     4\t", new: "X", replaceAll: true });
      await bad("a\nb\nc\n\nd\n", { old: "     4\t", new: "X" });
    });
    test("去掉以后出现多处：拒绝，带行号（不按行号挑）", async () => {
      const r = await bad("if x {\n}\nif y {\n}\n", { old: "     4\t}", new: "     4\t} // y" });
      assert.match(r.text, /^原文出现 2 次（在第 2、4 行）/);
    });
  });

  describe("老的找不到时：old、new 末尾那一行“注：”是抄 read 结果时带上的", () => {
    const CUT = "\n注：old、new 末尾都有同一行“注：…”，当作从结果里抄来的，已去掉再找。";
    test("两行一字不差才去掉再找，去掉以后说一句；先原样找，所以真的“注：”行不受影响", async () => {
      await ok("a\nb\nc\n", { old: "     2\tb\n注：路径 \"x\" 当作 E:/x。", new: "B\n注：路径 \"x\" 当作 E:/x。" }, "a\nB\nc\n", `${NUM.replace("。", "")}；old、new 末尾都有同一行“注：…”，当作从结果里抄来的，已去掉再找。`);
      await ok("foo\nbar\n", { old: "bar\n注：参数 old_string 当作 old。", new: "baz\n注：参数 old_string 当作 old。" }, "foo\nbaz\n", CUT);
      await ok("a\n注：甲。\n", { old: "a\n注：甲。", new: "b\n注：乙。" }, "b\n注：乙。\n");
    });
    test("反例一：注行不一样，old 只是笔误，不去掉；不能静默只改一半", async () => {
      const content = "## 标题\n说明文字。\n注：旧的说明。\n";
      const r = await bad(content, { old: "说明文字。\n注：旧说明。", new: "新的说明文字。\n注：新的说明。" });
      assert.match(r.text, /没找到原文/);
    });
    test("反例二：注行不一样，不报“替换以后文件一模一样”", async () => {
      const r = await bad("## 标题\n说明文字。\n注：旧的说明。\n", { old: "说明文字。\n注：旧说明。", new: "说明文字。\n注：新的说明。" });
      assert.doesNotMatch(r.text, /一模一样/);
    });
    test("反例三：replaceAll 不会改到别处", async () => {
      await bad("- 备份数据库\n注：要停服务。\n- 清理日志\n- 备份数据库\n", { old: "- 备份数据库\n注：要先停服务。", new: "- 备份数据库（已做）\n注：停了服务。", replaceAll: true });
    });
    test("只有 old 带注行：不去掉", async () => {
      await bad("a\nb\nc\n", { old: "     2\tb\n注：路径 \"x\" 当作 E:/x。", new: "B" });
    });
  });

  describe("行尾空白", () => {
    test("文件有行尾空白，old 没有：没改的行保留", async () => {
      await ok("a \nb", { old: "a\nb", new: "a\nc" }, "a \nc", WS);
      await ok("function f() {  \r\n  return 1;\r\n}\r\n", { old: "function f() {\n  return 1;", new: "function f() {\n  return 2;" }, "function f() {  \r\n  return 2;\r\n}\r\n", WS);
    });
    test("Markdown 硬换行", async () => {
      await ok("l1  \nl2  \nl3\n", { old: "l1\nl2\nl3", new: "l1\nL2\nl3" }, "l1  \nL2\nl3\n", WS);
      await ok("line one  \nline two  \nline three\n", { old: "line one\nline two", new: "line one\nline 2" }, "line one  \nline 2  \nline three\n", WS);
    });
    test("去行尾空白：old 末行的空白个数或种类写错，文件那一行的空白一起换掉", async () => {
      await ok("foo = 1  \nbar\n", { old: "foo = 1   ", new: "foo = 1" }, "foo = 1\nbar\n", WS);
      await ok("foo = 1\t\nbar\n", { old: "foo = 1   ", new: "foo = 1" }, "foo = 1\nbar\n", WS);
      await ok("a = 1 \nb = 2\t\nc\n", { old: "a = 1 \nb = 2  ", new: "a = 1\nb = 2" }, "a = 1\nb = 2\nc\n", WS);
    });
    test("边界：行中间不认、放宽后两处拒绝、末尾多换行", async () => {
      await bad("x = foo + 1\n", { old: "foo  ", new: "bar" });
      const r = await bad("a  \nb\na \nb\n", { old: "a\nb", new: "x" });
      assert.match(r.text, /^原文出现 2 次（在第 1、3 行）/);
      await ok("a\nb", { old: "b\n", new: "c\n" }, "a\nc\n", WS);
    });
    test("old 只有空白：不放宽", async () => {
      await bad("abc", { old: "  ", new: "X" });
      await bad("abc\ndef\n", { old: "  ", new: "X", replaceAll: true });
    });
    test("$& 照字面", async () => {
      await ok("a  \nX\n", { old: "a\nX", new: "[$&][$1][$$]\n$'" }, "[$&][$1][$$]\n$'\n", WS);
    });
    test("很长的 old：不抛", async () => {
      const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
      await ok(big.join("\n") + "\n", { old: big.join("\n"), new: "X" }, "X\n");
      await ok(big.join("\r\n") + "\r\n", { old: big.join("\n"), new: "X" }, "X\r\n");
      const r = await bad(big.map((l) => `${l} `).join("\n") + "\n", { old: big.join("\n"), new: "X" });
      assert.match(r.text, /^没找到原文/);
      assert.ok(r.text.length < 200000);
      const long = "x".repeat(40000);
      await ok(`a\n${long}\nb\n`, { old: long, new: "y" }, "a\ny\nb\n");
    });
  });

  describe("old 为空", () => {
    const NEW = "\n注：old 是空的，文件原来不存在或者是空的，按新建写入。";
    test("文件不存在（多层新目录）：新建", async () => {
      const p = path.join(dir, "new2", "deep", "n.txt");
      const r = await ed({ path: p, old: "", new: "hello" });
      assert.equal(r.isError, false);
      assert.match(r.text, /^已写入 5 字节：.*\n注：old 是空的，文件原来不存在或者是空的，按新建写入。$/);
      assert.equal(await body(p), "hello");
    });
    test("0 字节：照写；目录：报错不抛", async () => {
      await ok("", { old: "", new: "x" }, "x", NEW);
      const d = path.join(dir, "adir");
      await mkdir(d, { recursive: true });
      assert.equal((await ed({ path: d, old: "", new: "x" })).isError, true);
    });
    test("文件不空：拒绝，下一步先 read，不叫模型直接 write", async () => {
      const r = await bad("abc", { old: "", new: "x" });
      assert.match(r.text, /^old 是空的，可这个文件已经有 3 字节：.*。先 read 看内容；/);
      assert.match(r.text, /确实要整个换掉，读过以后再用 write。$/);
    });
  });

  describe("替换以后不变", () => {
    test("old 和 new 一样：错误，不写", async () => {
      const r = await bad("hello\n", { old: "hello", new: "hello" });
      assert.match(r.text, /一模一样/);
      await bad("a  \nb\n", { old: "a\nb", new: "a\nb" });
      await bad("a\nb\n", { old: "     1\ta", new: "     1\ta" });
    });
    test("old 和 new 不一样，文件已经是 new 的样子：成功，不写", async () => {
      const r = await ok("a = 1\nb\n", { old: "a = 1   ", new: "a = 1" }, "a = 1\nb\n", WS);
      assert.match(r.text, /^文件已经是 new 的样子，没有改动：/);
    });
  });

  describe("出现多次", () => {
    test("带行号和下一步", async () => {
      const r = await bad("a-a-a", { old: "a", new: "b" });
      assert.match(r.text, /^原文出现 3 次（在第 1 行），必须唯一：.*。只改一处：old 多带上下一两行；全部都改：加 "replaceAll": true。$/);
      const r7 = await bad("x\nx\nx\nx\nx\nx\nx\n", { old: "x", new: "y" });
      assert.match(r7.text, /（在第 1、2、3、4、5… 行）/);
    });
  });

  describe("找不到", () => {
    test("Tab 对空格：点出缩进，印出原文；照抄印出的行就成功", async () => {
      const p = await tmp("func f() {\n\treturn 1\n}\n");
      const r = await ed({ path: p, old: "func f() {\n    return 1\n}", new: "x" });
      assert.equal(r.isError, true);
      assert.ok(r.text.includes('第 2 行缩进不同：文件里是 "\\t"，old 里是 "    "'), r.text);
      assert.ok(r.text.endsWith("\n     1\tfunc f() {\n     2\t\treturn 1\n     3\t}"), r.text);
      const shown = r.text.split("\n").slice(1).join("\n");
      const r2 = await ed({ path: p, old: shown, new: shown.replace("return 1", "return 2") });
      assert.equal(r2.isError, false, r2.text);
      assert.equal(await body(p), "func f() {\n\treturn 2\n}\n");
    });
    test("单行 old 的缩进也比；第 0 行是半行时不误报", async () => {
      const r = await bad("func f() {\n\treturn 1\n}\n", { old: "    return 1", new: "    return 2" });
      assert.match(r.text, /最像的是第 2 行，第 2 行缩进不同：文件里是 "\\t"，old 里是 "    "/);
      const py = "class T:\n    def test_b(self):\n        response = get()\n";
      const r2 = await bad(py, { old: "def test_b(self):\n        response = gett()", new: "x" });
      assert.doesNotMatch(r2.text, /缩进不同/);
    });
    test("最长的行重复出现：用只出现一次的行定位，照抄以后改对地方", async () => {
      const py = ["class T(unittest.TestCase):", "    def test_a(self):", '        response = self.client.get("/a")', "        self.assertEqual(response.status_code, 200)", "", "    def test_b(self):", '        response = self.client.get("/b")', "        self.assertEqual(response.status_code, 200)", ""].join("\n");
      const p = await tmp(py);
      const r = await ed({ path: p, old: 'def test_b(self):\n    response = self.client.get("/b")\n    self.assertEqual(response.status_code, 200)', new: "x" });
      assert.match(r.text, /最像的是第 6 到 8 行/);
      const shown = r.text.split("\n").slice(1).join("\n");
      assert.equal((await ed({ path: p, old: shown, new: shown.replace("200", "404") })).isError, false);
      assert.equal(await body(p), py.replace('"/b")\n        self.assertEqual(response.status_code, 200)', '"/b")\n        self.assertEqual(response.status_code, 404)'));
    });
    test("一行都定不了位：文字 A", async () => {
      const r = await bad("abc", { old: "xyz", new: "1" });
      assert.match(r.text, /^没找到原文：.*。old 里最长的几行，在文件里要么没有，要么不止一处/);
    });
    test("Claude Code 的 → 写法：也去掉行号再定位", async () => {
      const r = await bad("const a = 1;\nconst b = 2;\n", { old: "     2→const b = 2;", new: "const b = 3;" });
      assert.match(r.text, /最像的是第 2 行。/);
    });
  });

  test("LF 文件，old 和 new 带 \\r\\n", async () => {
    await ok("a\nb\nc\n", { old: "a\r\nb", new: "x\r\ny" }, "x\ny\nc\n");
  });
});
