// MCP 页的纯逻辑（extras/gui/web/lib/mcp.js）：能装的定义和字节数、已装定义分组、工具名折成服务器、空闲的文字。
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTools, groupByServer, idleText, installable, LIMIT, sizeOf, withGroup } from "../../../extras/gui/web/lib/mcp.js";

type GenTool = import("../../../extras/gui/web/lib/mcp.js").GenTool;
type InstalledDef = import("../../../extras/gui/web/lib/mcp.js").InstalledDef;
const gen = (tool: string, o: { name?: string; bytes?: number; status?: "none" | "installed" | "differs"; skip?: string } = {}): GenTool => ({
  tool,
  name: o.name ?? `s_${tool}`,
  description: "",
  bytes: o.bytes ?? 100,
  status: o.status ?? "none",
  ...(o.skip === undefined ? {} : { skip: o.skip }),
});
/** 一个 MCP 生成的定义。 */
const def = (server: string, name: string): InstalledDef => ({ name, mcp: { server, tool: name.slice(server.length + 1) } });

test("能装的：跳过的以外全部，已装的也在里面", () => {
  const tools = [gen("a"), gen("b", { status: "installed" }), gen("big", { skip: "参数太大" })];
  assert.deepEqual(
    installable(tools).map((t) => t.tool),
    ["a", "b"],
  );
  assert.deepEqual(installable([]), []);
  assert.deepEqual(installable([gen("x", { skip: "写不进命令" })]), []);
});

test("能装的字节数：对着 64 KiB；超了给警告", () => {
  const tools = [gen("a", { bytes: 1000 }), gen("b", { bytes: 2000 }), gen("skip", { bytes: 9000, skip: "参数太大" })];
  assert.deepEqual(sizeOf(tools), { bytes: 3000, limit: LIMIT, ratio: 3000 / 65536, over: false });
  assert.deepEqual(sizeOf([]), { bytes: 0, limit: LIMIT, ratio: 0, over: false });
  const big = [gen("a", { bytes: LIMIT }), gen("b", { bytes: 1 })];
  const over = sizeOf(big);
  assert.equal(over.over, true);
  assert.ok(over.ratio > 1);
  assert.equal(sizeOf([gen("a", { bytes: LIMIT })]).over, false, "刚好到上限不算超");
});

test("已装定义按服务器分组：MCP 生成的进组，别的进 others，组的顺序按第一次出现", () => {
  const installed = [def("fake", "fake_count"), { name: "shell" }, def("pyd", "pyd_draw"), def("fake", "fake_picture"), { name: "手写的" }];
  const { groups, others } = groupByServer(installed);
  assert.deepEqual(
    groups.map((g) => [g.server, g.defs.map((d) => d.name)]),
    [
      ["fake", ["fake_count", "fake_picture"]],
      ["pyd", ["pyd_draw"]],
    ],
  );
  assert.deepEqual(
    others.map((d) => d.name),
    ["shell", "手写的"],
  );
  assert.deepEqual(groupByServer([]), { groups: [], others: [] });
});

test("折成服务器：全选时一项写整个服务器", () => {
  const defs = [def("fake", "fake_count"), def("fake", "fake_picture"), { name: "shell" }];
  assert.deepEqual(foldTools(["shell", "fake_count", "fake_picture"], defs), [
    { kind: "tool", name: "shell" },
    { kind: "mcp", server: "fake", on: 2, total: 2, names: ["fake_count", "fake_picture"] },
  ]);
});

test("折成服务器：只选一部分时 on 比 total 小，names 还是全部定义名", () => {
  const defs = [def("fake", "fake_a"), def("fake", "fake_b"), def("fake", "fake_c")];
  assert.deepEqual(foldTools(["fake_b"], defs), [{ kind: "mcp", server: "fake", on: 1, total: 3, names: ["fake_a", "fake_b", "fake_c"] }]);
});

test("折成服务器：defs 里没有的名字当普通工具，服务器一个都没选就不出现", () => {
  const defs = [def("fake", "fake_a"), def("pyd", "pyd_draw")];
  assert.deepEqual(foldTools(["shell", "fake_a", "gone_tool"], defs), [
    { kind: "tool", name: "shell" },
    { kind: "mcp", server: "fake", on: 1, total: 1, names: ["fake_a"] },
    { kind: "tool", name: "gone_tool" },
  ]);
  assert.deepEqual(foldTools(["shell"], defs), [{ kind: "tool", name: "shell" }]);
});

test("折成服务器：服务器项在它第一个定义名的位置，其余保持原顺序", () => {
  const defs = [def("fake", "fake_a"), def("fake", "fake_b"), def("pyd", "pyd_draw")];
  const folded = foldTools(["read", "fake_b", "write", "pyd_draw", "fake_a", "bash"], defs);
  assert.deepEqual(
    folded.map((f) => (f.kind === "tool" ? f.name : `mcp:${f.server}`)),
    ["read", "mcp:fake", "write", "mcp:pyd", "bash"],
  );
});

test("折成服务器：空的名字和空的 defs", () => {
  assert.deepEqual(foldTools([], [def("fake", "fake_a")]), []);
  assert.deepEqual(foldTools([], []), []);
  assert.deepEqual(foldTools(["read", "shell"], []), [
    { kind: "tool", name: "read" },
    { kind: "tool", name: "shell" },
  ]);
  // 名字重复只算一项。
  assert.deepEqual(foldTools(["fake_a", "fake_a"], [def("fake", "fake_a")]), [
    { kind: "mcp", server: "fake", on: 1, total: 1, names: ["fake_a"] },
  ]);
});

test("一组全选、全不选：别的保持原顺序，新加的接在后面", () => {
  assert.deepEqual(withGroup(["x", "a", "y"], ["a", "b"], true), ["x", "y", "a", "b"]);
  assert.deepEqual(withGroup(["x", "a", "y", "b"], ["a", "b"], false), ["x", "y"]);
  assert.deepEqual(withGroup([], ["a"], true), ["a"]);
  assert.deepEqual(withGroup(["a"], [], false), ["a"]);
});

test("空闲多久的文字：秒、分钟、小时", () => {
  assert.equal(idleText(0), "0 秒");
  assert.equal(idleText(999), "1 秒");
  assert.equal(idleText(45_000), "45 秒");
  assert.equal(idleText(60_000), "1 分钟");
  assert.equal(idleText(59 * 60_000), "59 分钟");
  assert.equal(idleText(60 * 60_000), "1 小时");
  assert.equal(idleText(90 * 60_000), "1 小时 30 分钟");
  assert.equal(idleText(Number.NaN), "0 秒");
});
