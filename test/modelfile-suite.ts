// 模型补充文件的读法（D105）。读取和校验的规则在这里测，src/server/modelfiles.ts 和 extras 里的拷贝共用一套。
// 自包含：不导入 src/，读法由调用方传进来。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Obj = Record<string, unknown>;

/** 一个合格的条目。 */
export const entry = (id: string, extra: Obj = {}): Obj => ({
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
  ...extra,
});

export function modelFileSuite(label: string, read: (dir: string, provider: string) => readonly Obj[]): void {
  describe(`模型补充文件的读法：${label}`, () => {
    let dir = "";
    let n = 0;
    before(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "tau-modelfile-"));
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    /** 写 `<provider>.json`（用唯一的 provider 名，互不干扰），读回来。 */
    const run = (content: string | Buffer | undefined): readonly Obj[] => {
      const provider = `p${n++}`;
      if (content !== undefined) writeFileSync(path.join(dir, `${provider}.json`), content);
      return read(dir, provider);
    };
    const runModels = (models: unknown, top: Obj = {}): readonly Obj[] => run(JSON.stringify({ ...top, models }));
    const ids = (r: readonly Obj[]): unknown[] => r.map((m) => m.id);
    const one = (e: Obj): readonly Obj[] => runModels([e]);

    test("没有文件：空", () => {
      assert.deepEqual(run(undefined), []);
    });
    test("目录不存在：空", () => {
      assert.deepEqual(read(path.join(dir, "nope"), "x"), []);
    });
    test("文件名位置是个目录：空", () => {
      mkdirSync(path.join(dir, "isdir.json"));
      assert.deepEqual(read(dir, "isdir"), []);
    });
    for (const [name, text] of [
      ["空文件", ""],
      ["不是 JSON", "{models: ["],
      ["顶层是数组", "[]"],
      ["顶层是 null", "null"],
      ["顶层是字符串", '"x"'],
      ["缺 models", "{}"],
      ["models 是对象", '{"models":{}}'],
      ["models 是 null", '{"models":null}'],
    ] as const) {
      test(`坏文件整份忽略：${name}`, () => {
        assert.deepEqual(run(text), []);
      });
    }
    test("超过大小上限的文件整份忽略，恰好在上限内的照读", () => {
      const pad = (size: number): string => {
        const head = JSON.stringify({ models: [entry("a")], pad: "" }).length;
        return JSON.stringify({ models: [entry("a")], pad: "x".repeat(size - head) });
      };
      const max = 1024 * 1024;
      assert.deepEqual(ids(run(pad(max))), ["a"]);
      assert.deepEqual(run(pad(max + 1)), []);
    });
    test("别的顶层键忽略", () => {
      assert.deepEqual(ids(runModels([entry("a")], { version: 3, note: "x", extra: [1] })), ["a"]);
    });
    test("合格的条目原样读出，provider 补成文件的 provider", () => {
      const provider = `p${n}`;
      const r = runModels([entry("a")]);
      assert.deepEqual(r, [{ ...entry("a"), provider }]);
    });
    test("别的条目的顺序保持，坏条目跳过", () => {
      assert.deepEqual(ids(runModels([entry("a"), 5, null, "x", [], entry("b", { maxTokens: 0 }), entry("c")])), ["a", "c"]);
    });

    describe("id", () => {
      for (const [name, id] of [["缺", undefined], ["数字", 1], ["空串", ""], ["201 个字符", "x".repeat(201)], ["含换行", "a\nb"], ["含 NUL", "a\u0000b"], ["含 DEL", "a\u007fb"]] as const) {
        test(`坏 id 跳过：${name}`, () => {
          const e = entry("a");
          if (id === undefined) delete e.id;
          else e.id = id;
          assert.deepEqual(one(e), []);
        });
      }
      test("200 个字符、斜杠、中文都行", () => {
        assert.deepEqual(ids(runModels([entry("x".repeat(200)), entry("org/m2"), entry("模型")])), ["x".repeat(200), "org/m2", "模型"]);
      });
      test("id 重复：只用第一条", () => {
        const r = runModels([entry("a", { name: "first" }), entry("b"), entry("a", { name: "second" })]);
        assert.deepEqual(r.map((m) => [m.id, m.name]), [["a", "first"], ["b", "b"]]);
      });
      test("第一条是坏条目：它不占 id，后面合格的那条照用", () => {
        const r = runModels([entry("a", { contextWindow: -1 }), entry("a", { name: "second" })]);
        assert.deepEqual(r.map((m) => m.name), ["second"]);
      });
    });

    describe("字符串字段", () => {
      for (const key of ["name", "baseUrl", "api"]) {
        test(`${key} 缺或不是字符串：跳过`, () => {
          const missing = entry("a");
          delete missing[key];
          assert.deepEqual(one(missing), []);
          assert.deepEqual(one(entry("a", { [key]: 1 })), []);
          assert.deepEqual(one(entry("a", { [key]: null })), []);
        });
      }
      test("api 是空串：跳过；name 和 baseUrl 是空串：行", () => {
        assert.deepEqual(one(entry("a", { api: "" })), []);
        assert.deepEqual(ids(one(entry("a", { name: "", baseUrl: "" }))), ["a"]);
      });
    });

    describe("reasoning", () => {
      test("布尔行，别的跳过", () => {
        assert.deepEqual(ids(one(entry("a", { reasoning: true }))), ["a"]);
        for (const v of [undefined, "true", 1, null]) {
          const e = entry("a");
          if (v === undefined) delete e.reasoning;
          else e.reasoning = v;
          assert.deepEqual(one(e), []);
        }
      });
    });

    describe("input", () => {
      test("含 text 的行", () => {
        assert.deepEqual(ids(one(entry("a", { input: ["text", "image"] }))), ["a"]);
        assert.deepEqual(ids(one(entry("a", { input: ["image", "text"] }))), ["a"]);
      });
      for (const [name, v] of [["缺", undefined], ["不是数组", "text"], ["空数组", []], ["只有 image", ["image"]], ["有别的值", ["text", "audio"]], ["重复", ["text", "text"]], ["含非字符串", ["text", 1]]] as const) {
        test(`跳过：${name}`, () => {
          const e = entry("a");
          if (v === undefined) delete e.input;
          else e.input = v;
          assert.deepEqual(one(e), []);
        });
      }
    });

    describe("contextWindow 和 maxTokens", () => {
      for (const key of ["contextWindow", "maxTokens"]) {
        test(`${key}：正的安全整数行`, () => {
          assert.deepEqual(ids(one(entry("a", { [key]: 1 }))), ["a"]);
          assert.deepEqual(ids(one(entry("a", { [key]: Number.MAX_SAFE_INTEGER }))), ["a"]);
        });
        for (const [name, v] of [["0", 0], ["负数", -1], ["小数", 1.5], ["超出安全整数", 2 ** 53], ["字符串", "100"], ["null", null], ["布尔", true]] as const) {
          test(`${key} 跳过：${name}`, () => {
            assert.deepEqual(one(entry("a", { [key]: v })), []);
          });
        }
        test(`${key} 缺：跳过`, () => {
          const e = entry("a");
          delete e[key];
          assert.deepEqual(one(e), []);
        });
      }
    });

    describe("cost", () => {
      const keys = ["input", "output", "cacheRead", "cacheWrite"];
      test("0 和小数行", () => {
        assert.deepEqual(ids(one(entry("a", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))), ["a"]);
        assert.deepEqual(ids(one(entry("a", { cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 3.75 } }))), ["a"]);
      });
      test("cost 缺、不是对象、数组、null：跳过", () => {
        const e = entry("a");
        delete e.cost;
        assert.deepEqual(one(e), []);
        for (const v of ["x", 1, [], null]) assert.deepEqual(one(entry("a", { cost: v })), []);
      });
      for (const key of keys) {
        const base = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
        test(`cost.${key} 缺、负数、非有限数、字符串：跳过`, () => {
          const { [key]: _drop, ...rest } = base as Record<string, number>;
          assert.deepEqual(one(entry("a", { cost: rest })), []);
          for (const v of [-0.1, "1", null]) assert.deepEqual(one(entry("a", { cost: { ...base, [key]: v } })), []);
          // JSON 里没有 NaN 和 Infinity；1e999 读出来是 Infinity。
          assert.deepEqual(run(JSON.stringify({ models: [entry("a", { cost: { ...base, [key]: "__INF__" } })] }).replace('"__INF__"', "1e999")), []);
        });
      }
      test("cost 里别的键放行", () => {
        assert.deepEqual(ids(one(entry("a", { cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, tiers: [] } }))), ["a"]);
      });
    });

    describe("provider 和 type", () => {
      test("provider 缺：补成文件的 provider", () => {
        const provider = `p${n}`;
        assert.equal(runModels([entry("a")])[0]!.provider, provider);
      });
      test("provider 等于文件的：行", () => {
        const provider = `p${n}`;
        assert.equal(runModels([entry("a", { provider })])[0]!.provider, provider);
      });
      test("provider 是别家的、空串、不是字符串：跳过", () => {
        for (const v of ["other", "", 1, null]) assert.deepEqual(one(entry("a", { provider: v })), []);
      });
      test("type 缺或 chat：行，type 原样留着", () => {
        assert.equal("type" in one(entry("a"))[0]!, false);
        assert.equal(one(entry("a", { type: "chat" }))[0]!.type, "chat");
      });
      test("type 是别的：跳过", () => {
        for (const v of ["image", "classifier", "", 1, null]) assert.deepEqual(one(entry("a", { type: v })), []);
      });
    });

    // 输出上限归内核（cap = min(model.maxTokens, 快照的上限)）。pi-ai 的 OpenAI 适配器会让 samplingParams 顶掉上限，compat 能让它不发上限，所以带这些的条目整条跳过。
    describe("不许绕过输出上限", () => {
      const reserved = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
      for (const key of reserved) {
        test(`samplingParams 含 ${key}：跳过`, () => {
          assert.deepEqual(one(entry("a", { samplingParams: { [key]: 999_999 } })), []);
          assert.deepEqual(one(entry("a", { samplingParams: { temperature: 0.5, [key]: 1 } })), []);
        });
        test(`samplingParamsByThinkingLevel 某一级含 ${key}：跳过`, () => {
          assert.deepEqual(one(entry("a", { samplingParamsByThinkingLevel: { low: { temperature: 0.1 }, high: { [key]: 999_999 } } })), []);
        });
      }
      test("samplingParams 不是对象：跳过", () => {
        for (const v of ["x", 1, true, null, []]) assert.deepEqual(one(entry("a", { samplingParams: v })), []);
      });
      test("samplingParamsByThinkingLevel 不是对象，或者某一级不是对象：跳过", () => {
        for (const v of ["x", 1, null, []]) assert.deepEqual(one(entry("a", { samplingParamsByThinkingLevel: v })), []);
        for (const level of ["x", 1, null, []]) assert.deepEqual(one(entry("a", { samplingParamsByThinkingLevel: { low: { temperature: 0.1 }, high: level } })), []);
      });
      test("不含保留键的 samplingParams 照收，原样交出", () => {
        const extra = { samplingParams: { temperature: 0.5, top_p: 0.9 }, samplingParamsByThinkingLevel: { low: { temperature: 0.1 }, high: {} } };
        const r = one(entry("a", extra))[0]!;
        assert.deepEqual(r.samplingParams, extra.samplingParams);
        assert.deepEqual(r.samplingParamsByThinkingLevel, extra.samplingParamsByThinkingLevel);
      });
      test("compat.supportsMaxOutputTokens 是 false：跳过；true、没写、compat 里别的键：照收", () => {
        assert.deepEqual(one(entry("a", { compat: { supportsMaxOutputTokens: false } })), []);
        assert.deepEqual(ids(one(entry("a", { compat: { supportsMaxOutputTokens: true } }))), ["a"]);
        assert.deepEqual(ids(one(entry("a", { compat: { supportsStore: false } }))), ["a"]);
        assert.deepEqual(ids(one(entry("a", { compat: {} }))), ["a"]);
      });
      test("被跳过的条目不占 id，后面合格的照用", () => {
        const r = runModels([entry("a", { samplingParams: { max_tokens: 1 } }), entry("a", { name: "second" })]);
        assert.deepEqual(r.map((m) => m.name), ["second"]);
      });
    });
    test("文件开头有 BOM：照常读", () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      assert.deepEqual(ids(run(Buffer.concat([bom, Buffer.from(JSON.stringify({ models: [entry("a")] }))]))), ["a"]);
    });
    test("不认识的条目键原样交出（嵌套的也不动）", () => {
      const extra = { headers: { "X-A": "1" }, compat: { supportsStore: false, deep: { a: [1, 2] } }, thinkingLevelMap: { low: null }, inputLimits: { maxPromptTokens: 5 }, whatever: [1, "x", null] };
      const r = one(entry("a", extra))[0]!;
      for (const [k, v] of Object.entries(extra)) assert.deepEqual(r[k], v, k);
    });
    test("条目里的 __proto__ 键不污染原型", () => {
      const text = JSON.stringify({ models: [entry("a")] }).replace(/^\{"models":\[\{/, '{"models":[{"__proto__":{"polluted":1},');
      const r = run(text);
      assert.equal(({} as Obj).polluted, undefined);
      assert.deepEqual(ids(r), ["a"]);
      assert.equal((r[0] as Obj).polluted, undefined);
    });
    test("读不会改文件", () => {
      const provider = `p${n++}`;
      const file = path.join(dir, `${provider}.json`);
      const text = JSON.stringify({ models: [entry("a")] });
      writeFileSync(file, text);
      read(dir, provider);
      read(dir, provider);
      assert.equal(read(dir, provider).length, 1);
    });
  });
}
