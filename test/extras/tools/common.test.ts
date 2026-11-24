// 工具库共用的参数规整（extras/tools/common.ts）：纯函数，不连服务。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { dropUnknown, refuseUnknown, takeArgs, takeNotes } from "../../../extras/tools/common.ts";

afterEach(() => void takeNotes());

const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("没有抛错");
};

test("process_id 当作 process；说明只给一次", () => {
  assert.deepEqual(takeArgs("peek", { process_id: "abcd1234" }).args, { process: "abcd1234" });
  assert.equal(takeNotes(), "注：参数 process_id 当作 process。");
  assert.equal(takeNotes(), "");
});

test("wait：process、targets 当作 processes；同值的丢掉", () => {
  assert.deepEqual(takeArgs("wait", { process: "a" }).args.processes, ["a"]);
  takeNotes();
  assert.deepEqual(takeArgs("wait", { targets: ["b"] }).args.processes, ["b"]);
  takeNotes();
  const r = takeArgs("wait", { processes: ["a"], process: "a" });
  assert.deepEqual(r.args, { processes: ["a"] });
  assert.deepEqual(r.unknown, []);
  assert.match(takeNotes(), /去掉了和 processes 一样的参数 process/);
});

test("布尔不配给字符串：delete_preset {force:true} 缺 id", () => {
  assert.match(err(() => takeArgs("delete_preset", { force: true })), /delete_preset 缺参数 id/);
});

test("web_search：两项数组转不成字符串，拒绝并给照抄的调用", () => {
  const m = err(() => takeArgs("web_search", { keywords: ["a", "b"] }));
  assert.match(m, /缺参数 query/);
  assert.ok(m.includes('照这样调：web_search {"query": …}'), m);
  assert.deepEqual(takeArgs("web_search", { q: "node 24" }).args, { query: "node 24" });
});

test("create_preset：prompt 写成 system_prompt 不补；同值多带的也拒绝；dry_run 拒绝", () => {
  const full = { id: "x", workdir: "E:/tau", model: "a/b", tools: ["read"] };
  assert.match(err(() => takeArgs("create_preset", { ...full, system_prompt: "你好" })), /缺参数 prompt；不认识的参数：system_prompt/, "有副作用的工具不拿多出来的键补必填（E3）");
  const r = takeArgs("create_preset", { ...full, prompt: "你好", prompt2: "你好" });
  assert.deepEqual(r.unknown, ["prompt2"], "有副作用的工具不丢同值的多余参数（E3）");
  assert.equal(takeNotes(), "");
  const u = takeArgs("create_preset", { ...full, prompt: "你好", dry_run: true }).unknown;
  assert.deepEqual(u, ["dry_run"]);
  const m = err(() => refuseUnknown("create_preset", u));
  assert.match(m, /create_preset 没有参数 dry_run/);
  assert.match(m, /去掉 dry_run 再调/);
});

test("规范名和别写法都给了、值不一样：拒绝", () => {
  assert.match(err(() => takeArgs("peek", { process: "a", Process: "b" })), /都给了，值不一样/);
});

test("说明性的键不进 unknown，写明忽略了", () => {
  const r = takeArgs("peek", { process: "a", explanation: "看一眼" });
  assert.deepEqual(r.unknown, []);
  assert.match(takeNotes(), /peek 没有参数 explanation，忽略了/);
});

test("dropUnknown 丢掉不认识的参数并说明；只读工具用", () => {
  const r = takeArgs("peek", { process: "a", count: 10 });
  assert.deepEqual(r.unknown, ["count"]);
  dropUnknown("peek", r.unknown, "；多说一句");
  assert.equal(takeNotes(), "注：peek 没有参数 count，忽略了；多说一句。");
});

test("必填缺一个、多出来两个：拒绝，列出参数表", () => {
  const m = err(() => takeArgs("peek", { processes: "a", x: "b" }));
  assert.match(m, /peek 缺参数 process/);
  assert.match(m, /peek 的参数：process（必填）、last/);
});

// ---------- E3：有副作用的工具不猜 ----------

test("E3：create_preset 缺 prompt、多带 name：不拿 name 当 prompt，拒绝", () => {
  const full = { id: "x", workdir: "E:/tau", model: "a/b", tools: ["read"] };
  const m = err(() => takeArgs("create_preset", { ...full, name: "Code Reviewer" }));
  assert.match(m, /create_preset 缺参数 prompt；不认识的参数：name/);
  assert.match(m, /create_preset 的参数：/);
  assert.equal(takeNotes(), "");
  const t = err(() => takeArgs("create_preset", { id: "x", workdir: "E:/tau", model: "a/b", prompt: "p", name: "Code Reviewer" }));
  assert.match(t, /缺参数 tools；不认识的参数：name/);
});

test("E3：同值的参数不丢：computer 的 double:\"click\" 留在 unknown 里，由 refuseUnknown 拒绝", () => {
  const r = takeArgs("computer", { action: "click", coordinate: [10, 10], double: "click" });
  assert.deepEqual(r.unknown, ["double"]);
  assert.equal(takeNotes(), "");
  assert.match(err(() => refuseUnknown("computer", r.unknown)), /computer 没有参数 double/);
  assert.deepEqual(takeArgs("delete_preset", { id: "a", dry_run: "a" }).unknown, ["dry_run"]);
});

test("E3：只读的工具照旧：必填缺一个、形状对得上的多出来正好一个就补，其余多出来的留在 unknown 由 dropUnknown 丢掉", () => {
  assert.deepEqual(takeArgs("web_search", { q: "node 24" }).args, { query: "node 24" });
  takeNotes();
  const r = takeArgs("web_search", { q: "node 24", max_results: 3 });
  assert.deepEqual(r.args, { query: "node 24" });
  assert.deepEqual(r.unknown, ["max_results"]);
});

// ---------- E2：拒绝的文字写清去掉以后会怎样 ----------

test("E2：refuseUnknown 不再无条件写“其余参数不变”，写明去掉以后会怎样执行", () => {
  const m = err(() => refuseUnknown("create_preset", ["dry_run"], "create_preset 没有预演：去掉 dry_run 再调，就是真的建预设（写文件）。"));
  assert.match(m, /去掉 dry_run 再调，就是真的建预设/);
  assert.doesNotMatch(m, /其余参数不变/);
  assert.doesNotMatch(err(() => refuseUnknown("computer", ["x"])), /其余参数不变/);
});
