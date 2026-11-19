// 生成 MCP 工具定义（extras/mcp/gen.ts）：名字、规整参数、说明、大小、命令、超时。
// 生成的定义还要交给内核读工具定义的函数和 pi-ai 的校验过一遍。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { loadToolDef } from "../../../src/presets/tooldefs.ts";
import { toolsFor } from "../../../src/kernel/tools.ts";
import { clampTimeout, commandFor, DEF_MAX_BYTES, generateTools, LIB_DIR, normalizeSchema, parseCommand, RESERVED, toolDescription, toolNames } from "../../../extras/mcp/gen.ts";
import type { McpTool } from "../../../extras/mcp/gen.ts";

const NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

let dir = "";
let work = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tau-mcp-gen-"));
  work = join(dir, "work");
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(
    join(work, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "pixel-art": { command: "python", args: ["tools/pixel_art_mcp.py"], cwd: ".", timeout: 60, exposure: "direct", description: "Draw pixel art." },
        plain: { command: "python", args: ["x.py"] },
      },
    }),
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 规整后的 schema 里还有没有 $ref、$defs 这些东西。 */
function leftovers(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return void x.forEach(walk);
    if (typeof x !== "object" || x === null) return;
    for (const [k, val] of Object.entries(x)) {
      if (["$ref", "$defs", "definitions", "$schema", "$id"].includes(k)) out.push(k);
      walk(val);
    }
  };
  walk(v);
  return out;
}

const tool = (name: string, description = "说明", inputSchema: unknown = { type: "object", properties: {} }): McpTool => ({ name, description, inputSchema });

describe("名字", () => {
  test("服务器名和工具名拼起来，非法字符换成下划线", () => {
    assert.equal(toolNames("pixel art", ["draw.circle"]).get("draw.circle"), "pixel_art_draw_circle");
    assert.equal(toolNames("s", ["读 文件"]).get("读 文件"), "s_____");
    assert.equal(toolNames("s", ["ok-name_1"]).get("ok-name_1"), "s_ok-name_1");
  });

  test("太长：截短并加上由原名算出的短哈希，长度合规", () => {
    const server = "s".repeat(60);
    const name = toolNames(server, ["tool"]).get("tool")!;
    assert.match(name, NAME_OK);
    assert.equal(name.length, 64);
    assert.ok(name.endsWith(name.slice(-8)));
    // 同样的输入还是这个名字；顺序变了也一样。
    assert.equal(toolNames(server, ["tool", "other"]).get("tool"), name);
    assert.equal(toolNames(server, ["other", "tool"]).get("tool"), name);
  });

  test("去掉非法字符以后互相重名：两个都加哈希，结果不同", () => {
    const names = toolNames("s", ["a.b", "a_b"]);
    assert.notEqual(names.get("a.b"), names.get("a_b"));
    for (const n of names.values()) assert.match(n, NAME_OK);
    assert.equal(toolNames("s", ["a.b", "a_b"]).get("a.b"), names.get("a.b"));
  });

  test("和内置工具重名：加哈希", () => {
    const names = toolNames("memory", ["get"]);
    assert.notEqual(names.get("get"), "memory_get");
    assert.match(names.get("get")!, NAME_OK);
  });

  test("不撞名字的不加哈希", () => {
    assert.deepEqual([...toolNames("fake", ["count", "picture"])], [
      ["count", "fake_count"],
      ["picture", "fake_picture"],
    ]);
  });
});

describe("参数 schema", () => {
  test("顶层补成 type: object", () => {
    assert.deepEqual(normalizeSchema({ properties: { a: { type: "string" } } }), { properties: { a: { type: "string" } }, type: "object" });
    assert.deepEqual(normalizeSchema({}), { properties: {}, type: "object" });
    assert.deepEqual(normalizeSchema(undefined), { properties: {}, type: "object" });
    assert.deepEqual(normalizeSchema("x"), { properties: {}, type: "object" });
    assert.equal(normalizeSchema({ type: "array", items: [] })["type"], "object");
  });

  test("本地的 $ref 就地展开，$defs、definitions、$schema、$id 去掉", () => {
    const raw = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "x",
      type: "object",
      properties: {
        point: { $ref: "#/$defs/Point", description: "一个点" },
        old: { $ref: "#/definitions/Old" },
      },
      definitions: { Old: { type: "string" } },
      $defs: {
        Point: { type: "object", title: "Point", properties: { x: { type: "number", default: 1 } }, required: ["x"] },
      },
    };
    const out = normalizeSchema(raw);
    assert.deepEqual(leftovers(out), []);
    assert.deepEqual(out["properties"], {
      point: { type: "object", title: "Point", properties: { x: { type: "number", default: 1 } }, required: ["x"], description: "一个点" },
      old: { type: "string" },
    });
  });

  test("嵌套的 $defs 也展开；指不上的 $ref 换成 {}", () => {
    const raw = {
      type: "object",
      properties: {
        a: { $ref: "#/$defs/A" },
        missing: { $ref: "#/$defs/没有" },
      },
      $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, $defs: { B: { type: "string" } } } },
    };
    const out = normalizeSchema(raw);
    assert.deepEqual(leftovers(out), []);
    assert.deepEqual((out["properties"] as any).a, { type: "object", properties: { b: { type: "string" } } });
    assert.deepEqual((out["properties"] as any).missing, {});
  });

  test("递归的引用展开到一定深度以后换成 {}", () => {
    const raw = {
      type: "object",
      properties: { root: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { name: { type: "string" }, kids: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
    };
    const out = normalizeSchema(raw);
    assert.deepEqual(leftovers(out), []);
    // 展开过几层以后断开，但没有无限展开。
    const text = JSON.stringify(out);
    assert.ok(text.includes("kids"), text.slice(0, 200));
    assert.ok(text.length < 2000, `展开太大：${text.length}`);
  });

  test("任何深度都不留 $ref：数组里的也一样", () => {
    const out = normalizeSchema({
      type: "object",
      properties: { list: { type: "array", items: { anyOf: [{ $ref: "#/$defs/X" }, { type: "null" }] } } },
      $defs: { X: { type: "string", title: "X" } },
    });
    assert.deepEqual(leftovers(out), []);
    assert.deepEqual((out["properties"] as any).list.items.anyOf, [{ type: "string", title: "X" }, { type: "null" }]);
  });

  test("pi-ai 真校验：规整后的 schema 好参数能过，坏参数被拒", () => {
    const parameters = normalizeSchema({
      type: "object",
      properties: {
        point: { $ref: "#/$defs/Point" },
        color: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      },
      required: ["point"],
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], title: "Point" },
      },
    });
    const def = { description: "画一个点", parameters };
    const call = (args: Record<string, unknown>) => () =>
      validateToolArguments({ name: "pixel_art_draw", ...def }, { type: "toolCall", id: "t1", name: "pixel_art_draw", arguments: args as never });
    assert.doesNotThrow(call({ point: { x: 1, y: 2 } }));
    assert.doesNotThrow(call({ point: { x: "1", y: 2 }, color: "red" }));
    assert.throws(call({}));
    assert.throws(call({ point: { x: "abc", y: 2 } }));
    assert.throws(call({ point: { x: 1 } }));
  });
});

describe("说明、大小、命令、超时", () => {
  test("工具自己的说明在前，后面一行写服务器名和配置里的 description", () => {
    assert.equal(toolDescription(tool("t", "画像素"), "pixel-art", "Draw pixel art."), "画像素\n\nMCP 服务器 pixel-art：Draw pixel art.");
    assert.equal(toolDescription(tool("t", "画像素"), "plain", undefined), "画像素\n\nMCP 服务器 plain");
    assert.equal(toolDescription(tool("t", ""), "plain", undefined), "MCP 服务器 plain");
  });

  test("超时截到 1 到 600 秒，没写就是 120", () => {
    assert.deepEqual([clampTimeout(undefined), clampTimeout(0), clampTimeout(1000), clampTimeout(5.4), clampTimeout(60)], [120, 1, 600, 5, 60]);
  });

  test("命令：仓库路径用正斜杠，名字用单引号括起来；认得出服务器名和工具名", () => {
    const command = commandFor("pixel-art", "draw")!;
    assert.equal(command, `node "${LIB_DIR}/call.ts" 'pixel-art' 'draw'`);
    assert.ok(LIB_DIR.endsWith("extras/mcp") && !LIB_DIR.includes("\\"), LIB_DIR);
    assert.deepEqual(parseCommand(command), { server: "pixel-art", tool: "draw" });
    assert.equal(parseCommand("node E:/tau/extras/tools/shell.ts start"), null);
    assert.equal(parseCommand(`${command} extra`), null);
    assert.equal(commandFor("s", "it's"), null);
    assert.equal(commandFor("s", "a\nb"), null);
  });

  test("说明太长：先截说明并写明截断了", () => {
    const long = "说".repeat(20_000);
    const generated = generateTools(work, "plain", { instructions: undefined, tools: [tool("t", long)] });
    const t = generated.tools[0]!;
    assert.equal(t.skip, undefined);
    assert.ok(t.description.endsWith("（说明太长，已截断）"), t.description.slice(-40));
    assert.ok(bytes({ description: t.description, parameters: t.definition!["parameters"] }) <= DEF_MAX_BYTES);
    // 报给界面的字节数是整个定义的大小。
    assert.equal(t.bytes, bytes(t.definition));
  });

  test("参数自己就超了：跳过这个工具，给出原因", () => {
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { type: "string", description: "描述".repeat(20) }])) };
    const generated = generateTools(work, "plain", { instructions: undefined, tools: [tool("big", "说明", wide), tool("ok")] });
    assert.equal(generated.tools[0]!.definition, undefined);
    assert.match(generated.tools[0]!.skip!, /超过一个定义的 16384 字节上限/);
    assert.ok(generated.tools[1]!.definition !== undefined);
    // 跳过的工具不计入总量。
    assert.equal(generated.totalBytes, generated.tools[1]!.bytes);
  });

  test("工具名写不进命令：跳过这个工具", () => {
    const generated = generateTools(work, "plain", { instructions: undefined, tools: [tool("it's")] });
    assert.match(generated.tools[0]!.skip!, /单引号/);
    assert.equal(generated.tools[0]!.definition, undefined);
  });
});

describe("整个流程", () => {
  test("生成的定义内核读得出：字段、命令、超时、输出都对", () => {
    const tools = [tool("draw", "画一个像素", { type: "object", properties: { x: { type: "integer" } }, required: ["x"] }), tool("count")];
    const generated = generateTools(work, "pixel-art", { instructions: "画布说明", tools });
    assert.equal(generated.instructions, "画布说明");
    const defDir = join(dir, "tools");
    mkdirSync(defDir, { recursive: true });
    for (const t of generated.tools) {
      assert.equal(t.skip, undefined, t.skip);
      writeFileSync(join(defDir, `${t.name}.json`), JSON.stringify(t.definition));
      const read = loadToolDef(defDir, t.name);
      assert.equal(read.name, t.name);
      assert.equal(read.command, `node "${LIB_DIR}/call.ts" 'pixel-art' '${t.tool}'`);
      assert.equal(read.timeout, 60, "配置里的 timeout");
      assert.equal(read.output, "content");
      assert.ok(read.description.startsWith(t.tool === "draw" ? "画一个像素" : "说明"));
      assert.ok(read.description.includes("MCP 服务器 pixel-art：Draw pixel art."));
      assert.deepEqual(read.parameters, normalizeSchema(tools.find((x) => x.name === t.tool)!.inputSchema));
    }
    // 没有写 timeout 的服务器用默认的 120。
    const plain = generateTools(work, "plain", { instructions: undefined, tools: [tool("t")] });
    assert.equal(plain.tools[0]!.definition!["timeout"], 120);
    assert.equal(plain.totalBytes, plain.tools[0]!.bytes);
  });

  test("保留名单盖住内核的全部内置工具和工具组：内核加一个内置工具，这里就红", () => {
    const builtin = toolsFor({ tools: ["read", "write", "edit", "bash", "memory", "agents"], toolDefs: [] }).map((t) => t.name);
    for (const name of [...builtin, "memory", "agents"]) assert.ok(RESERVED.has(name), `保留名单漏了 ${name}`);
  });

  test("名字不撞：一个服务器的定义名互不相同", () => {
    const generated = generateTools(work, "plain", { instructions: undefined, tools: Array.from({ length: 20 }, (_, i) => tool(`t${i}`)) });
    assert.equal(new Set(generated.tools.map((t) => t.name)).size, 20);
  });
});
