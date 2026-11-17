// MCP 页的纯逻辑（extras/gui/web/lib/mcp.js）：默认勾选、勾选的字节数、已装定义分组、空闲的文字。
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPicked, groupByServer, idleText, LIMIT, sizeOf, withGroup } from "../../../extras/gui/web/lib/mcp.js";

type GenTool = import("../../../extras/gui/web/lib/mcp.js").GenTool;
const gen = (tool: string, o: { name?: string; bytes?: number; status?: "none" | "installed" | "differs"; skip?: string } = {}): GenTool => ({
  tool,
  name: o.name ?? `s_${tool}`,
  description: "",
  bytes: o.bytes ?? 100,
  status: o.status ?? "none",
  ...(o.skip === undefined ? {} : { skip: o.skip }),
});

test("默认勾选：跳过的以外全部勾上，已装的也在里面", () => {
  const tools = [gen("a"), gen("b", { status: "installed" }), gen("big", { skip: "参数太大" })];
  assert.deepEqual(defaultPicked(tools), ["a", "b"]);
  assert.deepEqual(defaultPicked([]), []);
  assert.deepEqual(defaultPicked([gen("x", { skip: "写不进命令" })]), []);
});

test("勾选的字节数：只算选中的，对着 64 KiB；超了给警告", () => {
  const tools = [gen("a", { bytes: 1000 }), gen("b", { bytes: 2000 }), gen("c", { bytes: 4000 })];
  assert.deepEqual(sizeOf(tools, []), { bytes: 0, limit: LIMIT, ratio: 0, over: false });
  assert.deepEqual(sizeOf(tools, ["a", "c"]), { bytes: 5000, limit: 65536, ratio: 5000 / 65536, over: false });
  // 选中的名字里有服务器上没有的：不算。
  assert.equal(sizeOf(tools, ["a", "zzz"]).bytes, 1000);
  const big = [gen("a", { bytes: LIMIT }), gen("b", { bytes: 1 })];
  const over = sizeOf(big, ["a", "b"]);
  assert.equal(over.over, true);
  assert.ok(over.ratio > 1);
  assert.equal(sizeOf(big, ["a"]).over, false, "刚好到上限不算超");
});

test("已装定义按服务器分组：MCP 生成的进组，别的进 others，组的顺序按第一次出现", () => {
  const installed = [
    { name: "fake_count", mcp: { server: "fake", tool: "count" } },
    { name: "shell" },
    { name: "pyd_draw", mcp: { server: "pyd", tool: "draw_point" } },
    { name: "fake_picture", mcp: { server: "fake", tool: "picture" } },
    { name: "手写的" },
  ];
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
