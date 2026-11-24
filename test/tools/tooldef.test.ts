// 运行工具定义（设计稿 5.5）：用假的命令测参数走标准输入、退出码、超时、中止、输出上限，以及 content 输出的每种不合法。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IMAGE_MAX_BYTES } from "../../src/images.ts";
import { IMAGE_UNSUPPORTED } from "../../src/kernel/context.ts";
import { IMAGES_PER_MESSAGE, MESSAGE_MAX_BYTES } from "../../src/kernel/derive.ts";
import type { ToolDef } from "../../src/kernel/types.ts";
import { BLOB_PREFIX } from "../../src/store/blobs.ts";
import { bash } from "../../src/tools/bash.ts";
import { runToolDef } from "../../src/tools/tooldef.ts";
import { gif, png } from "../images.ts";
import { plain, textOfResult } from "../plain.ts";

const CTX = { process: "p-def", pipe: "\\\\.\\pipe\\tau-def-test" };
let dir = "";
let home = "";

before(async () => {
  // bash 工具的输出文件写在 ~/.tau/extras/shell：home 指到临时目录。
  home = await mkdtemp(path.join(os.tmpdir(), "tau-def-home-"));
  process.env.USERPROFILE = process.env.HOME = home;
  for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith("TAU_")) delete process.env[k];
  dir = await mkdtemp(path.join(os.tmpdir(), "tau-def-"));
});
after(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
});

const def = (command: string, extra: Partial<ToolDef> = {}): ToolDef => ({ name: "t", description: "", parameters: { type: "object", properties: {} }, command, timeout: 60, output: "text", ...extra });
const signal = () => new AbortController().signal;
const text = (command: string, args: unknown = {}, extra: Partial<ToolDef> = {}) => runToolDef(def(command, extra), args, dir, signal(), CTX, true).then(plain);
/** content 输出：命令是 `cat <文件>`，文件内容由测试写。 */
async function content(body: string | Buffer, accepts = true, extra: Partial<ToolDef> = {}) {
  const file = `out-${Math.random().toString(36).slice(2)}.json`;
  await writeFile(path.join(dir, file), body);
  return runToolDef(def(`cat ${file}`, { output: "content", ...extra }), {}, dir, signal(), CTX, accepts);
}
async function image(name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}
const item = (p: string) => ({ type: "image", path: p });

describe("text 输出：和 bash 一样", () => {
  test("参数的 JSON 从标准输入来，写完就关（cat 读到结尾才退出）", async () => {
    assert.deepEqual(await text("cat", { a: 1, 名: "中" }), { text: '{"a":1,"名":"中"}\n[退出码 0]', isError: false });
  });

  test("命令不读标准输入就退出：写入的 EPIPE 被忽略，服务没有退出", async () => {
    // 参数大到装不进管道缓冲，命令又立刻退出：写入一定撞上已关的管道。没有错误监听器时，Node 会按未捕获异常终止测试进程。
    const r = await text("echo hi", { blob: "x".repeat(4_000_000) });
    assert.deepEqual(r, { text: "hi\n[退出码 0]", isError: false });
  });

  test("bash 工具不给标准输入：是空设备，cat 马上读到结尾", async () => {
    assert.deepEqual(plain(await bash({ command: "cat; echo done" }, dir, signal(), CTX)), { text: "done\n[退出码 0]", isError: false });
  });

  test("退出码不是 0 就是错误；stderr 合在输出里", async () => {
    assert.deepEqual(await text("echo out; echo err >&2; exit 3"), { text: "out\nerr\n[退出码 3]", isError: true });
  });

  test("环境：TAU_PROCESS、TAU_PIPE，没有 MSYS_NO_PATHCONV；工作目录", async () => {
    const saved = process.env.MSYS_NO_PATHCONV;
    process.env.MSYS_NO_PATHCONV = "1";
    try {
      const r = await text('echo "$TAU_PROCESS $TAU_PIPE [${MSYS_NO_PATHCONV-unset}]"; pwd -W');
      assert.deepEqual(r, { text: `p-def ${CTX.pipe} [unset]\n${dir.replaceAll("\\", "/")}\n[退出码 0]`, isError: false });
    } finally {
      if (saved === undefined) delete process.env.MSYS_NO_PATHCONV;
      else process.env.MSYS_NO_PATHCONV = saved;
    }
  });

  test("超时用定义的 timeout：1 秒，远早于命令自己的 60 秒", async () => {
    const t0 = Date.now();
    const r = await text("echo before; sleep 60", {}, { timeout: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /\[超时：1 秒后结束了命令启动的进程。同样的调用多半还会超时：[^\]]*\]$/);
    assert.ok(Date.now() - t0 < 30_000);
  });

  test("工作目录不存在：说清不是命令的错，不运行", async () => {
    const gone = path.join(dir, "gone");
    const r = plain(await runToolDef(def("echo x > made.txt"), {}, gone, signal(), CTX, true));
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith(`工作目录 ${gone.replaceAll("\\", "/")} 不存在了（被删了或改了名）。`), r.text);
  });

  test("中止：调用前已中止就不运行；运行中中止会结束命令", async () => {
    const done = new AbortController();
    done.abort();
    assert.deepEqual(plain(await runToolDef(def("echo x > ran.txt"), {}, dir, done.signal, CTX, true)), { text: "已中止，命令没有运行", isError: true });
    const ac = new AbortController();
    const run = runToolDef(def("echo started; sleep 60"), {}, dir, ac.signal, CTX, true);
    setTimeout(() => ac.abort(), 1500);
    const r = plain(await run);
    assert.equal(r.isError, true);
    assert.match(r.text, /\[已中止，结束了命令启动的进程\]$/);
  });

  test("输出上限：巨量输出只留头尾，结果不超过上限", async () => {
    const r = await text("seq 1 800000");
    assert.ok(Buffer.byteLength(r.text) <= MESSAGE_MAX_BYTES);
    assert.match(r.text, /^1\n/);
    assert.match(r.text, /…（中间省略 \d+ 字节）…/);
    assert.match(r.text, /800000\n\[退出码 0\]$/);
  });
});

describe("content 输出", () => {
  test("文本项按顺序用换行连起来，成为一个文本块；退出码 0 时丢掉 stderr", async () => {
    const r = await content('[{"type":"text","text":"甲"},{"type":"text","text":"乙"}]');
    assert.deepEqual(r, { content: [{ type: "text", text: "甲\n乙" }], isError: false });
  });

  test("退出码 0 时丢掉 stderr", async () => {
    const file = path.join(dir, "ok.json");
    await writeFile(file, '[{"type":"text","text":"只有这个"}]');
    const r = await runToolDef(def("cat ok.json; echo 错误 >&2", { output: "content" }), {}, dir, signal(), CTX, true);
    assert.deepEqual(r, { content: [{ type: "text", text: "只有这个" }], isError: false });
  });

  test("参数也走标准输入", async () => {
    const r = await runToolDef(def(`node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify([{type:"text",text:JSON.parse(s).q}])))'`, { output: "content" }), { q: "问" }, dir, signal(), CTX, true);
    assert.deepEqual(r, { content: [{ type: "text", text: "问" }], isError: false });
  });

  test("退出码不是 0：错误，文字和 text 时一样（stdout 和 stderr 按到达顺序合在一起）", async () => {
    const command = "echo '[]'; echo 坏了 >&2; exit 2";
    const asText = await runToolDef(def(command), {}, dir, signal(), CTX, true);
    const asContent = await runToolDef(def(command, { output: "content" }), {}, dir, signal(), CTX, true);
    assert.deepEqual(asContent, asText);
    assert.deepEqual(plain(asContent), { text: "[]\n坏了\n[退出码 2]", isError: true });
  });

  test("超时和中止：错误，和 text 时一样", async () => {
    const r = await runToolDef(def("echo '[]'; sleep 60", { output: "content", timeout: 1 }), {}, dir, signal(), CTX, true);
    assert.equal(r.isError, true);
    assert.match(textOfResult(r), /\[超时：1 秒后结束了命令启动的进程。同样的调用多半还会超时：[^\]]*\]$/);
  });

  test("没有输出和空数组：合法，没有内容块", async () => {
    assert.deepEqual(await content("[]"), { content: [], isError: false });
  });

  describe("不合法：结果是错误 content 输出不合法：<说明>", () => {
    const bad = async (body: string | Buffer, why: RegExp, accepts = true) => {
      const r = await content(body, accepts);
      assert.equal(r.isError, true);
      assert.match(textOfResult(r), new RegExp(`^content 输出不合法：${why.source}`));
      assert.equal("images" in r, false);
    };

    test("标准输出超过上限被截断", async () => {
      const filler = JSON.stringify([{ type: "text", text: "字".repeat(30_000) }]);
      await bad(filler, /标准输出超过上限/);
    });
    test("不是合法的 JSON", () => bad("不是 json", /不是合法的 JSON/));
    test("空输出", () => bad("", /不是合法的 JSON/));
    test("不是数组", () => bad('{"type":"text","text":"x"}', /必须是 JSON 数组/));
    test("项不是对象", async () => {
      await bad('["x"]', /第 1 项的格式不对/);
      await bad("[null]", /第 1 项的格式不对/);
      await bad("[[]]", /第 1 项的格式不对/);
    });
    test("type 不认识、字段缺失或类型不对", async () => {
      await bad('[{"type":"text","text":"a"},{"type":"audio","path":"x"}]', /第 2 项的格式不对/);
      await bad('[{"type":"text"}]', /第 1 项的格式不对/);
      await bad('[{"type":"text","text":1}]', /第 1 项的格式不对/);
      await bad('[{"type":"image"}]', /第 1 项的格式不对/);
      await bad('[{"type":"image","path":5}]', /第 1 项的格式不对/);
      await bad('[{"text":"x"}]', /第 1 项的格式不对/);
    });
    test(`图片超过 ${IMAGES_PER_MESSAGE} 张：不读文件，所以文件不存在也是这个原因`, () => {
      const items = Array.from({ length: IMAGES_PER_MESSAGE + 1 }, (_, i) => item(`C:\\不存在\\${i}.png`));
      return bad(JSON.stringify(items), new RegExp(`有 ${IMAGES_PER_MESSAGE + 1} 张图片，最多 ${IMAGES_PER_MESSAGE} 张`));
    });
    test("path 不是 Windows 的绝对路径：相对路径、msys 路径、盘符相对路径、单斜杠", async () => {
      for (const p of ["x.png", "/tmp/x.png", "C:x.png", "\\x.png", "/e/x.png"]) await bad(JSON.stringify([item(p)]), /图片的 path 必须是 Windows 的绝对路径/);
    });
    test("文件读不出：不存在、是目录", async () => {
      await bad(JSON.stringify([item(path.join(dir, "没有这个.png"))]), /图片文件读不出：.*文件不存在/);
      await bad(JSON.stringify([item(dir)]), /图片文件读不出：.*不是文件/);
    });
    test("\\\\ 开头的路径被认作绝对路径，读不出才是原因（纯本地，不触发名字解析）", () => bad(JSON.stringify([item("\\\\?\\" + path.join(dir, "没有这个.png"))]), /图片文件读不出/));
    test("文件超过 IMAGE_MAX_BYTES：先看大小，不读", async () => {
      const p = await image("big.png", Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_MAX_BYTES)]));
      await bad(JSON.stringify([item(p)]), /图片文件读不出：.*没有读取/);
    });
    test("图片不合格：类型不认识、尺寸超过 2000", async () => {
      await bad(JSON.stringify([item(await image("fake.png", Buffer.from("不是图片的字节")))]), /第 1 张图片的类型不认识/);
      await bad(JSON.stringify([item(await image("wide.png", png(2001, 10)))]), /第 1 张图片是 2001×10/);
    });
    test("第二张不合格：说明里是第几张", async () => {
      const ok = await image("ok.png", png(5, 5));
      await bad(JSON.stringify([item(ok), item(await image("wide2.png", png(5, 2001)))]), /第 2 张图片是 5×2001/);
    });
    test("不收图片的模型：同样的检查，不合格还是错误", () => bad(JSON.stringify([item("x.png")]), /图片的 path 必须是 Windows 的绝对路径/, false));
  });

  describe("图片", () => {
    test("合法：文本项一个文本块，图片块是 blob:<hash> 引用，images 带着字节；同一次结果里文本在前", async () => {
      const a = await image("a.png", png(10, 20, 1));
      const b = await image("b.gif", gif(30, 40, 2));
      const r = await content(JSON.stringify([item(a), { type: "text", text: "说明" }, item(b)]));
      assert.equal(r.isError, false);
      assert.ok(r.images && r.images.length === 2);
      const [ia, ib] = r.images;
      assert.deepEqual(r.content, [
        { type: "text", text: "说明" },
        { type: "image", data: BLOB_PREFIX + ia!.hash, mimeType: "image/png" },
        { type: "image", data: BLOB_PREFIX + ib!.hash, mimeType: "image/gif" },
      ]);
      assert.deepEqual(ia!.bytes, png(10, 20, 1));
    });

    test("只有图片：没有文本块", async () => {
      const r = await content(JSON.stringify([item(await image("only.png", png(1, 1)))]));
      assert.deepEqual(r.content.map((c) => c.type), ["image"]);
    });

    test("同一张图片出现两次：两个引用，哈希相同", async () => {
      const p = await image("twice.png", png(3, 3, 9));
      const r = await content(JSON.stringify([item(p), item(p)]));
      assert.equal(r.content.length, 2);
      assert.deepEqual(r.content[0], r.content[1]);
    });

    test("文件路径可以用正斜杠", async () => {
      const p = await image("slash.png", png(2, 2, 3));
      const r = await content(JSON.stringify([item(p.replaceAll("\\", "/"))]));
      assert.equal(r.isError, false);
      assert.equal(r.images?.length, 1);
    });

    test("模型不收图片：图片在原位置换成一行说明，不存，没有 images", async () => {
      const p = await image("noimg.png", png(4, 4, 5));
      const r = await content(JSON.stringify([{ type: "text", text: "前" }, item(p), { type: "text", text: "后" }]), false);
      assert.deepEqual(r, { content: [{ type: "text", text: `前\n${IMAGE_UNSUPPORTED}\n后` }], isError: false });
    });
  });
});

describe("content 输出里声明库内动作（D64 第 10 组）", () => {
  const call = (name: unknown, args?: unknown) => ({ type: "call", name, ...(args === undefined ? {} : { arguments: args }) });
  const bad = async (body: string, why: RegExp) => {
    const r = await content(body);
    assert.equal(r.isError, true);
    assert.match(textOfResult(r), new RegExp(`^content 输出不合法：${why.source}`));
    assert.equal("calls" in r, false);
    assert.equal("images" in r, false);
  };

  test("call 项按顺序收进 calls；arguments 省略时是 {}；文本照常", async () => {
    const r = await content(JSON.stringify([{ type: "text", text: "好" }, call("post", { to: "b", text: "x" }), call("stop_process")]));
    assert.deepEqual(r, { content: [{ type: "text", text: "好" }], isError: false, calls: [{ name: "post", arguments: { to: "b", text: "x" } }, { name: "stop_process", arguments: {} }] });
  });

  test("只有 call：内容是空的；没有 call 时结果里没有 calls 这个键", async () => {
    assert.deepEqual(await content(JSON.stringify([call("self")])), { content: [], isError: false, calls: [{ name: "self", arguments: {} }] });
    assert.equal("calls" in (await content(JSON.stringify([{ type: "text", text: "a" }]))), false);
  });

  test("模型不收图片时 calls 照样在", async () => {
    const p = await image("c-noimg.png", png(4, 4, 9));
    const r = await content(JSON.stringify([item(p), call("memory_get", { key: "k" })]), false);
    assert.deepEqual(r, { content: [{ type: "text", text: IMAGE_UNSUPPORTED }], isError: false, calls: [{ name: "memory_get", arguments: { key: "k" } }] });
  });

  test("最多 8 个：8 个合法，9 个整份不合法", async () => {
    const some = (n: number) => JSON.stringify(Array.from({ length: n }, () => call("self")));
    assert.equal(((await content(some(8))).calls ?? []).length, 8);
    await bad(some(9), /有 9 个 call，最多 8 个/);
  });

  test("name 不是字符串、arguments 不是对象：整份不合法，不留任何声明", async () => {
    await bad(JSON.stringify([call("self"), call(5)]), /第 2 项的格式不对/);
    await bad(JSON.stringify([call(undefined)]), /第 1 项的格式不对/);
    await bad(JSON.stringify([call("post", [])]), /第 1 项的格式不对/);
    await bad(JSON.stringify([call("post", null)]), /第 1 项的格式不对/);
    await bad(JSON.stringify([call("post", "x")]), /第 1 项的格式不对/);
  });

  test("先查每一项的格式，再查 call 个数，最后查图片张数", async () => {
    const calls = Array.from({ length: 9 }, () => call("self"));
    const images = Array.from({ length: IMAGES_PER_MESSAGE + 1 }, (_, i) => item(`C:\不存在\${i}.png`));
    await bad(JSON.stringify([...calls, ...images, { type: "audio" }]), /第 \d+ 项的格式不对/);
    await bad(JSON.stringify([...calls, ...images]), /有 9 个 call/);
    await bad(JSON.stringify([call("self"), ...images]), /有 3 张图片/);
  });

  test("退出码不是 0、超时：没有声明", async () => {
    const r = await runToolDef(def(`echo '[{"type":"call","name":"self"}]'; exit 2`, { output: "content" }), {}, dir, signal(), CTX, true);
    assert.equal(r.isError, true);
    assert.equal("calls" in r, false);
    const t = await runToolDef(def(`echo '[{"type":"call","name":"self"}]'; sleep 60`, { output: "content", timeout: 1 }), {}, dir, signal(), CTX, true);
    assert.equal(t.isError, true);
    assert.equal("calls" in t, false);
  });

  test("输出被截断：整份不合法，没有声明", () => bad(JSON.stringify([call("self"), { type: "text", text: "字".repeat(30_000) }]), /标准输出超过上限/));

  test("text 输出的工具不解释 call 项：原样是文字", async () => {
    const r = await text(`echo '[{"type":"call","name":"self"}]'`);
    assert.equal(r.isError, false);
    assert.match(r.text, /"type":"call"/);
  });
});
