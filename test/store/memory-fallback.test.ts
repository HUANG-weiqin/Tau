// D109 记忆工具的兜底（U6）：真库上走 runInStore。先在原代码上跑，应当全红；改后全绿。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@earendil-works/pi-ai";
import { start } from "../../src/kernel/decide.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { runDeclared, runInStore } from "../../src/store/instore.ts";
import { plain, res, textOfResult } from "../plain.ts";
import { PRESET, tempDb, toolCall } from "./fixtures.ts";

const setup = (t: TestContext) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  const p = start("p1", PRESET, { now: 0, memoryView: "" });
  const run = (name: string, args: JsonObject) => plain(runInStore(db, memory, p, [], toolCall("c", name, args), 0));
  const seed = (key: string, value: string, brief = "摘") => {
    const r = memory.set(PRESET.id, key, { value, brief, now: 0 }, null);
    assert.ok(r.ok);
    return r.version;
  };
  const get = (k: string) => memory.get(PRESET.id, k);
  const out = (k: string) => run("memory_get", { key: k }).text;
  return { db, memory, p, run, seed, get, out };
};
const conflictText = (key: string, v: number, value: string, tail: string, brief = "摘") => `版本冲突，没有写入。现在的值是 ${key}（版本 ${v}，更新 1970-01-01）：\n摘要：${brief}\n${value}\n${tail}`;

test("memory_set 没给 brief：新键用值的开头当摘要，已有的键摘要不变；写失败时不接注", (t) => {
  const { run, seed, get } = setup(t);
  assert.deepEqual(run("memory_set", { key: "a", value: "值" }), { text: "已写入 a，版本 1。\n注：没给 brief，用值的开头当摘要。", isError: false });
  assert.equal(get("a")?.brief, "值");
  run("memory_set", { key: "l", value: "长".repeat(100) });
  assert.equal(get("l")?.brief, "长".repeat(66), "300 字节的值，摘要取前 200 字节，不切断字符");
  const v = seed("pref", "用 pnpm。", "用户的包管理偏好，装依赖前读");
  assert.deepEqual(run("memory_set", { key: "pref", value: "用 bun。", version: v }), { text: `已写入 pref，版本 ${v + 1}。\n注：没给 brief，摘要不变。`, isError: false });
  assert.equal(get("pref")?.brief, "用户的包管理偏好，装依赖前读");
  assert.deepEqual(run("memory_set", { key: "pref", value: "x" }), { text: conflictText("pref", v + 1, "用 bun。", `要覆盖，带 version=${v + 1} 再写一次。`, "用户的包管理偏好，装依赖前读"), isError: true }, "冲突：没有注");
  assert.deepEqual(run("memory_set", { key: "big", value: "长".repeat(1500), version: 3 }), { text: "超出上限，没有写入：值有 4500 字节，上限 4096 字节。一个汉字占 3 字节。把内容拆成几个键，或者写进文件。", isError: true }, "超限：没有注");
  assert.equal(get("big"), null);
  assert.deepEqual(run("memory_set", { key: "e", value: "v", brief: "" }), { text: `已写入 e，版本 ${v + 2}。`, isError: false }, "空串 brief 照写，不补");
});

test("memory_set 的 version：键存在时只认对上的正整数，别的都冲突并给能照抄的版本号；新键带 0、负数没有注，带别的有注", (t) => {
  const { run, seed, get } = setup(t);
  const v = seed("k", "旧");
  for (const version of [1.5, "latest", "", 0, -1]) {
    assert.deepEqual(run("memory_set", { key: "k", value: "新", brief: "b", version }), { text: conflictText("k", v, "旧", `要覆盖，带 version=${v} 再写一次。`), isError: true }, String(version));
  }
  assert.equal(get("k")?.value, "旧");
  assert.deepEqual(run("memory_set", { key: "k", value: "新", brief: "b", version: `${v}.0` }), { text: `已写入 k，版本 ${v + 1}。`, isError: false });
  assert.deepEqual(run("memory_set", { key: "k", value: "再", brief: "b", version: ` ${v + 1} ` }), { text: `已写入 k，版本 ${v + 2}。`, isError: false });
  // 键名打错：带了 version 就是以为键在，注一句让它看得出来（D107）；0、负数是“新键”的意思，不注（D86）。
  assert.deepEqual(run("memory_set", { key: "kk", value: "x", brief: "b", version: "latest" }), { text: `已写入 kk，版本 ${v + 3}。\n注：键 kk 原来不存在，当新建写，没看 version。`, isError: false });
  assert.deepEqual(run("memory_set", { key: "k2", value: "x", brief: "b", version: 1.5 }), { text: `已写入 k2，版本 ${v + 4}。\n注：键 k2 原来不存在，当新建写，没看 version。`, isError: false });
  assert.deepEqual(run("memory_set", { key: "k3", value: "x", brief: "b", version: 0 }), { text: `已写入 k3，版本 ${v + 5}。`, isError: false });
  assert.deepEqual(run("memory_set", { key: "k4", value: "x", version: 7 }), { text: `已写入 k4，版本 ${v + 6}。\n注：没给 brief，用值的开头当摘要；键 k4 原来不存在，当新建写，没看 version。`, isError: false }, "几处兜底合成一行");
});

test("memory_delete：键本来就不存在算成功；键在而 version 没带、不是整数或对不上，冲突并给能照抄的版本号", (t) => {
  const { run, seed, get } = setup(t);
  for (const args of [{ key: "gone", version: 1 }, { key: "gone", version: 0 }, { key: "gone" }, { key: "gone", version: "abc" }, { key: "gone", version: null }] as JsonObject[]) {
    assert.deepEqual(run("memory_delete", args), { text: "键 gone 本来就不存在，不用删。", isError: false }, JSON.stringify(args));
  }
  const v = seed("k", "值");
  for (const args of [{ key: "k" }, { key: "k", version: v + 7 }, { key: "k", version: 2.5 }, { key: "k", version: null }] as JsonObject[]) {
    assert.deepEqual(run("memory_delete", args), { text: conflictText("k", v, "值", `要删，带 version=${v} 再删一次。`), isError: true }, JSON.stringify(args));
  }
  assert.equal(get("k")?.value, "值");
  assert.deepEqual(run("memory_delete", { key: "k", version: `${v}.0` }), { text: "已删除 k。", isError: false });
});

test("memory_edit 的 version：键不存在先说不存在；键在而 version 没带、不是整数或对不上，冲突并给能照抄的版本号", (t) => {
  const { run, seed, get } = setup(t);
  assert.deepEqual(run("memory_edit", { key: "nokey", old: "a", new: "b" }), { text: "键 nokey 不存在。要新建，用 memory_set。", isError: true });
  const v = seed("k", "甲乙");
  for (const args of [{}, { version: v + 9 }, { version: 1.5 }, { version: null }] as JsonObject[]) {
    assert.deepEqual(run("memory_edit", { key: "k", old: "甲", new: "丙", ...args }), { text: conflictText("k", v, "甲乙", `要改，先确认 old 还在上面的值里，再带 version=${v} 改一次。`), isError: true }, JSON.stringify(args));
  }
  assert.equal(get("k")?.value, "甲乙");
  assert.match(run("memory_edit", { key: "k", old: "", new: "x", version: v }).text, /^参数错误：old 不能为空。要在末尾加内容，old 写值的最后一行（不带结尾的换行/);
});

test("memory_edit 的 old 照抄了 memory_get 的头：old、new 各自去掉再找；new 去完还像头就不写", (t) => {
  const { run, seed, get, out } = setup(t);
  let v = seed("k", "第一行\n第二行", "测试");
  const head = (k: string) => out(k).split("\n").slice(0, 2).join("\n") + "\n";
  assert.deepEqual(run("memory_edit", { key: "k", old: `${head("k")}第一行`, new: "改", version: v }), { text: `已写入 k，版本 ${v + 1}。\n注：old 开头照抄的 memory_get 头部已去掉。`, isError: false });
  assert.equal(get("k")?.value, "改\n第二行");
  v = get("k")!.version;
  const whole = out("k");
  assert.equal(run("memory_edit", { key: "k", old: whole, new: whole.replace("第二行", "二"), version: v }).isError, false, "old、new 都是整段输出");
  assert.equal(get("k")?.value, "改\n二");
  v = get("k")!.version;
  assert.equal(run("memory_edit", { key: "k", old: "摘要：测试\n改", new: "三", version: v }).isError, false, "只抄了摘要那行");
  assert.equal(get("k")?.value, "三\n二");
  v = get("k")!.version;
  assert.equal(run("memory_edit", { key: "k", old: `${head("k")}三`, new: "摘要：测试\n四", version: v }).isError, false, "old 带头两行，new 只带摘要那行：各自去掉");
  assert.equal(get("k")?.value, "四\n二");
  // new 带着改过的头（改了摘要行、版本号），以前是“没找到原文”，现在也不写：不能把头写进值里。
  const refuse = { text: "new 开头也带着 memory_get 的头，和现在的不一样，没有写入。old、new 都只写值的正文；要改摘要，用 brief。", isError: true };
  v = get("k")!.version;
  const w = out("k");
  assert.deepEqual(run("memory_edit", { key: "k", old: w, new: w.replace("摘要：测试", "摘要：新摘要"), version: v, brief: "新摘要" }), refuse);
  assert.deepEqual(run("memory_edit", { key: "k", old: w, new: w.replace(`版本 ${v}`, `版本 ${v + 1}`).replace("四", "五"), version: v }), refuse);
  assert.deepEqual(get("k"), { value: "四\n二", brief: "测试", updated: 0, version: v });
  assert.equal(run("memory_edit", { key: "k", old: head("k"), new: "x", version: v }).isError, true, "old 只有头：不去，照旧没找到");
});

test("memory_edit 的 old 两头多了值里没有的换行：按值的开头、末尾对上，只认一处；原样找得到时不变", (t) => {
  const { run, seed, get } = setup(t);
  const edit = (value: string, old: string, neu: string) => {
    const key = `k${Math.random()}`;
    const v = seed(key, value);
    return { r: run("memory_edit", { key, old, new: neu, version: v }), value: get(key)?.value };
  };
  const END = "\n注：old 结尾的换行值里没有，按值的末尾对上了。";
  const START = "\n注：old 开头的换行值里没有，按值的开头对上了。";
  assert.deepEqual(edit("第一行\n第二行", "第二行\n", "改\n").value, "第一行\n改");
  assert.match(edit("第一行\n第二行", "第二行\n", "改\n").r.text, new RegExp(`${END}$`));
  assert.equal(edit("第一行\n第二行", "第二行\n", "").value, "第一行");
  const s = edit("第一行\n第二行", "\n第一行", "\n改");
  assert.equal(s.value, "改\n第二行");
  assert.match(s.r.text, new RegExp(`${START}$`));
  assert.equal(edit("abc", "abc\n", "xyz\n").value, "xyz");
  assert.equal(edit("- a\n- b", "- b\n", "- b\n- c\n").value, "- a\n- b\n- c", "在末尾追加");
  for (const [value, old] of [["abc def", "abc\n"], ["a\nb", "b\n\n"], ["abc", "\n"]]) {
    const { r, value: after } = edit(value!, old!, "x");
    assert.equal(r.isError, true, JSON.stringify([value, old]));
    assert.match(r.text, /^没找到原文，没有写入。old 要从下面的值里逐字复制/);
    assert.equal(after, value);
  }
  const raw = edit("a\nb\nc", "b\n", "B\n");
  assert.deepEqual([raw.r.text.includes("注："), raw.value], [false, "a\nB\nc"], "原样找得到：照旧，没有注");
});

test("memory_edit 没找到原文：文字直接给出不带头的值，不再让它去 memory_get", (t) => {
  const { run, seed } = setup(t);
  const v = seed("k", "甲 乙 丙");
  assert.deepEqual(run("memory_edit", { key: "k", old: "丁", new: "乙", version: v }), { text: "没找到原文，没有写入。old 要从下面的值里逐字复制，包括标点、空格和换行，不要带 memory_get 的头两行。现在的值：\n甲 乙 丙", isError: true });
});

test("给了但不是字符串：说收到的是对象或数组，不说“缺少”；没给的说缺少；内容的别名照做", (t) => {
  const { run, seed } = setup(t);
  assert.match(run("memory_set", { key: "o", value: { a: 1 }, brief: "b" }).text, /^参数错误：value 要字符串，收到的是 对象。memory_set 的参数：/);
  assert.match(run("memory_set", { key: "o", value: "v", brief: ["x"] }).text, /^参数错误：brief 要字符串，收到的是 数组。/);
  const v = seed("k", "甲");
  assert.match(run("memory_edit", { key: "k", old: "甲", new: { x: 1 }, version: v }).text, /^参数错误：new 要字符串，收到的是 对象。/);
  assert.match(run("memory_set", { key: "o", brief: "b" }).text, /^参数错误：缺少 value。/);
  assert.match(run("memory_set", { key: "o", content: "v", brief: "b" }).text, /^已写入 o，版本 \d+。\n注：参数 content 当作 value。$/);
});

test("brief、version 给 null 同没给；别的必填参数是 null 照旧报错", (t) => {
  const { run } = setup(t);
  assert.deepEqual(run("memory_set", { key: "k", value: "v", brief: null }), { text: "已写入 k，版本 1。\n注：没给 brief，用值的开头当摘要。", isError: false });
  assert.match(run("memory_set", { key: "k", value: null, brief: "b" }).text, /^参数错误：value 是 null，必填/);
  assert.match(run("memory_edit", { key: "k", old: "v", new: null, version: 1 }).text, /^参数错误：new 是 null，必填/);
});

test("声明的动作：memory_set 不带 brief 能写；memory_delete 删不存在的键算成功，后面的照常执行", (t) => {
  const { db, memory, p, get } = setup(t);
  const r = runDeclared(db, memory, p, [], res("ok"), [{ name: "memory_delete", arguments: { key: "nope", version: 1 } }, { name: "memory_set", arguments: { key: "after", value: "v" } }], 0);
  assert.equal(r.isError, false);
  assert.equal(textOfResult(r), "ok\n\n[memory_delete] 键 nope 本来就不存在，不用删。\n\n[memory_set] 已写入 after，版本 1。\n注：没给 brief，用值的开头当摘要。");
  assert.equal(get("after")?.brief, "v");
});
