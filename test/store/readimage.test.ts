// `read` 读图片经过执行器：accepts 取自会话快照的 input（D76）。工具本身的行为见 test/tools/files.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../../src/executor/actions.ts";
import { start } from "../../src/kernel/decide.ts";
import { IMAGE_UNSUPPORTED } from "../../src/kernel/context.ts";
import { png } from "../images.ts";
import { PRESET, tempDir, toolCall } from "./fixtures.ts";

async function runRead(dir: string, input: Array<"text" | "image">) {
  const process = start("p1", { ...PRESET, workdir: dir, input }, { now: 0, memoryView: "" });
  const call = toolCall("c1", "read", { path: "pic.png" });
  const job = { process, segment: [], effect: { kind: "runTool" as const, n: 1, call } };
  const actions = createActions({} as Models, () => {}, "test-pipe", () => undefined);
  return actions.runTool(job, call, new AbortController().signal, new AbortController().signal);
}

test("read：模型收图片时图片块带 blob 引用，字节交给执行器存", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pic.png"), png(8, 8, 1));
  const r = await runRead(dir, ["text", "image"]);
  assert.equal(r.isError, false);
  assert.deepEqual(r.content.map((c) => c.type), ["image"]);
  assert.equal(r.images?.length, 1);
});

test("read：模型不收图片时只有占位行，不存图片", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "pic.png"), png(8, 8, 1));
  const r = await runRead(dir, ["text"]);
  assert.deepEqual(r.content, [{ type: "text", text: IMAGE_UNSUPPORTED }]);
  assert.equal("images" in r, false);
});
