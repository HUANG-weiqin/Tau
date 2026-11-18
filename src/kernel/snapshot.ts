// 会话快照的键分两类（D71，见 .knowledge/kb-kernel.md 的“流程：会话配置”）：调用参数立即生效，结构性字段换段时生效。纯函数。
import type { PresetSnapshot } from "./types.ts";

/** 调用参数：`reconfigure` 立即换，下一次调用模型起生效。快照里其余所有的键是结构性字段。 */
const CALL_KEYS: readonly string[] = ["thinking", "handoff", "options"];

/** 投影的 `pending.fields` 里能出现的名字，按这个顺序排。 */
const ORDER = ["model", "prompt", "tools", "workdir", "context"];

/** 待输出的一项：一段现成的文字，或者一个还没展开的值。 */
type Job = { text: string } | { value: unknown };

/**
 * 稳定序列化：对象的键排序、跳过 undefined，所以键的顺序不同不算不同。
 * 不递归：用显式的栈，嵌套多深都不会爆调用栈（工具定义的 `parameters` 只受 16 KB 限制，能嵌套几千层）。
 */
function stable(root: unknown): string {
  const out: string[] = [];
  const jobs: Job[] = [{ value: root }];
  for (let job = jobs.pop(); job !== undefined; job = jobs.pop()) {
    if ("text" in job) {
      out.push(job.text);
      continue;
    }
    const v = job.value;
    if (Array.isArray(v)) {
      out.push("[");
      jobs.push({ text: "]" });
      for (let i = v.length - 1; i >= 0; i--) {
        jobs.push({ value: v[i] });
        if (i > 0) jobs.push({ text: "," });
      }
    } else if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      out.push("{");
      jobs.push({ text: "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        jobs.push({ value: o[keys[i]!] });
        jobs.push({ text: `${JSON.stringify(keys[i])}:` });
        if (i > 0) jobs.push({ text: "," });
      }
    } else out.push(JSON.stringify(v) ?? "null");
  }
  return out.join("");
}

/** 两份快照的结构性字段里不一样的键，换成对外的名字：`contextWindow`、`input` 是按 `model` 查目录得来的，算 `model`；`toolDefs` 算 `tools`。 */
export function pendingFields(a: PresetSnapshot, b: PresetSnapshot): string[] {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  const names = new Set<string>();
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!CALL_KEYS.includes(k) && stable(x[k]) !== stable(y[k])) names.add(k === "contextWindow" || k === "input" ? "model" : k === "toolDefs" ? "tools" : k);
  }
  return [...ORDER.filter((n) => names.has(n)), ...[...names].filter((n) => !ORDER.includes(n)).sort()];
}

/** 结构性字段相等。 */
export const sameStructure = (a: PresetSnapshot, b: PresetSnapshot): boolean => pendingFields(a, b).length === 0;

/** `base` 的结构性字段，加上 `from` 的三个调用参数（`from` 没有的键，结果里也没有）。 */
export function withCallParams(base: PresetSnapshot, from: Pick<PresetSnapshot, "thinking" | "handoff" | "options">): PresetSnapshot {
  const { thinking: _t, handoff: _h, options: _o, ...rest } = base;
  const { thinking, handoff, options } = from;
  return { ...rest, ...(thinking === undefined ? {} : { thinking }), ...(handoff === undefined ? {} : { handoff }), ...(options === undefined ? {} : { options }) };
}
