// 弱模型填参数常出错：可选参数写 null、必填写 null、数字和布尔写成字符串，或者反过来。库内和库外工具共用这一处修正。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixArgs } from "../../src/tools/args.ts";

const schema = {
  type: "object",
  properties: { path: { type: "string" }, offset: { type: "integer" }, all: { type: "boolean" }, items: { type: "array" }, meta: { type: "object" } },
  required: ["path"],
  additionalProperties: false,
};

test("可选参数的 null 当作没填；没有 null 时参数原样", () => {
  assert.deepEqual(fixArgs(schema, { path: "a", offset: null, all: null }), { args: { path: "a" } });
  assert.deepEqual(fixArgs(schema, {}), { args: {} });
});

test("必填参数的 null 是错误，不会变成字符串", () => {
  assert.deepEqual(fixArgs(schema, { path: null }), { error: "参数 path 是 null，必须给出一个值。" });
  assert.deepEqual(fixArgs({ ...schema, required: [] }, { path: null }), { args: {} });
});

test("按 schema 转换标量：数字和布尔转字符串，字符串转整数和布尔；转不了的留着让校验报错", () => {
  assert.deepEqual(fixArgs(schema, { path: 1, offset: "3", all: "true" }), { args: { path: "1", offset: 3, all: true } });
  assert.deepEqual(fixArgs(schema, { path: "a", offset: "3.5", all: "yes" }), { args: { path: "a", offset: "3.5", all: "yes" } });
});

test("schema 里没有的键原样留着（库内工具和库外工具都由各自校验拒绝多余字段）", () => {
  assert.deepEqual(fixArgs(schema, { path: "a", extra: 1 }), { args: { path: "a", extra: 1 } });
});

test("字符串化的 JSON 数组和对象按 schema 解析；类型不对或不是合法 JSON 留着让校验报错", () => {
  assert.deepEqual(fixArgs(schema, { path: "a", items: '["p1","p2"]', meta: '{"k":1}' }), { args: { path: "a", items: ["p1", "p2"], meta: { k: 1 } } });
  assert.deepEqual(fixArgs(schema, { path: "a", items: '{"not":"array"}', meta: "[1,2]" }), { args: { path: "a", items: '{"not":"array"}', meta: "[1,2]" } });
  assert.deepEqual(fixArgs(schema, { path: "a", items: "[bad" }), { args: { path: "a", items: "[bad" } });
});
