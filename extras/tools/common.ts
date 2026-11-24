// 工具库共用的小件：读参数、查环境、数据目录、出错写法。不导入 src/。
import { homedir } from "node:os";
import path from "node:path";
import { CATALOG } from "./catalog.ts";

/** 给模型看的错误：消息原样写到标准错误，退出码 1。 */
export class Fail extends Error {}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 工具只在 tau 里运行：执行器给命令设了 TAU_PROCESS 和 TAU_PIPE。 */
export function tauEnv(): { proc: string; pipe: string } {
  const proc = process.env.TAU_PROCESS;
  const pipe = process.env.TAU_PIPE;
  if (!proc || !pipe) throw new Fail("这个工具只能在 tau 的工具调用里运行：没有 TAU_PROCESS 或 TAU_PIPE。");
  if (!ID.test(proc)) throw new Fail(`TAU_PROCESS 不是合法的进程 ID：${proc}`);
  return { proc, pipe };
}

/** 标准输入是参数的 JSON，一个对象。 */
export async function readArgs(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Fail("参数不是合法的 JSON。");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Fail("参数必须是 JSON 对象。");
  return v as Record<string, unknown>;
}

/** `~/.tau/extras/<name>`：上层的数据目录。 */
export function extrasDir(name: string): string {
  return path.join(homedir(), ".tau", "extras", name);
}

// ---------- “注：”行：兜底照做时，在结果最后说一句改了什么 ----------

const notes: string[] = [];

/** 记一句兜底改了什么。 */
export function note(s: string): void {
  notes.push(s);
}

/** “注：”加各句（用“；”连）加“。”，然后清空；没有就是空串。 */
export function takeNotes(): string {
  if (notes.length === 0) return "";
  const text = `注：${notes.join("；")}。`;
  notes.length = 0;
  return text;
}

/** 入口：成功时把“注：”写成最后一行；出错写标准错误（原文在前，“注：”另起一行）、退出码 1。不要在里面留着不关的连接，否则进程不退出。 */
export function run(fn: () => Promise<void>): void {
  fn().then(
    () => {
      const n = takeNotes();
      if (n !== "") process.stdout.write(`${n}\n`);
    },
    (e: unknown) => {
      const n = takeNotes();
      process.stderr.write(`${e instanceof Fail ? e.message : `工具出错：${e instanceof Error ? e.message : String(e)}`}\n${n === "" ? "" : `${n}\n`}`);
      process.exitCode = 1;
    },
  );
}

// ---------- 参数规整：规则同内置工具，不写别名表 ----------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** 只是说明为什么调用的键：丢掉，不当成参数。 */
const NOISE = new Set(["reason", "explanation", "thought", "rationale", "description", "summary", "title", "note"]);

type Prop = { type?: string; items?: { type?: string } };

const jsonType = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/** 把 v 转成参数 p 的类型；转不成返回 undefined。 */
function coerce(v: unknown, p: Prop): unknown {
  const item = (x: unknown): unknown => (p.items?.type === "string" ? (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : undefined) : x);
  if (p.type === "string") {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return Array.isArray(v) && v.length === 1 && typeof v[0] === "string" ? v[0] : undefined;
  }
  if (p.type === "array") {
    if (Array.isArray(v)) return v;
    return typeof v === "object" && v !== null ? undefined : item(v) === undefined ? undefined : [item(v)];
  }
  if (p.type === "integer" || p.type === "number") {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && (p.type === "number" || Number.isInteger(n)) ? n : undefined;
  }
  return jsonType(v) === p.type ? v : undefined;
}

/** 值的形状能不能配给这个参数：同一种 JSON 类型，或者字符串和一项的字符串数组互换。布尔、数字不配给字符串。 */
function fits(v: unknown, p: Prop): boolean {
  if (coerce(v, p) === undefined) return false;
  const t = jsonType(v);
  if (p.type === "string") return t === "string" || t === "array";
  if (p.type === "array") return t === "array" || t === "string";
  return t === (p.type === "integer" ? "number" : p.type);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 会写、删、输入的工具：猜错了做错事收不回，所以不按“多出来正好一个”补必填，也不把“同值”的多余参数当副本丢掉（`double:"click"` 和 `action:"click"` 同值，丢掉就只单击一次）。 */
const SIDE_EFFECT = new Set(["create_preset", "delete_preset", "computer"]);

/** 参数表：必填的带“（必填）”。 */
function usage(name: string): string {
  const e = CATALOG.find((c) => c.name === name);
  const props = Object.keys((e?.parameters.properties ?? {}) as object);
  const req = (e?.parameters.required ?? []) as string[];
  const list = props.length === 0 ? "没有参数" : props.map((k) => (req.includes(k) ? `${k}（必填）` : k)).join("、");
  const call = `${name} {${req.map((k) => `"${k}": …`).join(", ")}}`;
  return `${name} 的参数：${list}。照这样调：${call}`;
}

/**
 * 按 CATALOG 里这个工具严格的 schema 规整参数：只差大小写和下划线的改名；必填正好缺一个、多出来的里形状相同的正好一个时改名（只读的工具；其余多出来的丢掉并说明）；
 * 同值的和说明性的丢掉。有副作用的工具（`SIDE_EFFECT`）不补、不丢同值的，多出来的都进 unknown。每处都记一句“注：”。返回的 `unknown` 是还不认识的键，由 dropUnknown（只读）或 refuseUnknown（会改东西）处理。
 */
export function takeArgs(name: string, raw: Record<string, unknown>): { args: Record<string, unknown>; unknown: string[] } {
  const entry = CATALOG.find((c) => c.name === name);
  const props = (entry?.parameters.properties ?? {}) as Record<string, Prop>;
  const required = (entry?.parameters.required ?? []) as string[];
  const out: Record<string, unknown> = {};
  let rest: [string, unknown][] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k in props) out[k] = v;
    else rest.push([k, v]);
  }
  const left: [string, unknown][] = [];
  const noise: string[] = [];
  for (const [k, v] of rest) {
    const target = Object.keys(props).find((p) => norm(p) === norm(k));
    const c = target === undefined ? undefined : coerce(v, props[target]!);
    if (target === undefined || c === undefined) left.push([k, v]);
    else if (!(target in out)) {
      out[target] = c;
      note(`参数 ${k} 当作 ${target}`);
    } else if (same(out[target], c)) note(`去掉了和 ${target} 一样的 ${k}`);
    else throw new Fail(`参数 ${target} 和 ${k} 都给了，值不一样，不知道哪个对。只写一个 ${target}，值写你要的那个，再调。`);
  }
  rest = left;
  const missing = (): string[] => required.filter((r) => !(r in out));
  const real = (): [string, unknown][] => rest.filter(([k]) => !NOISE.has(norm(k)));
  // 必填正好缺一个，多出来的键总共正好一个、形状又对得上：改名。
  if (!SIDE_EFFECT.has(name) && missing().length === 1) {
    const target = missing()[0]!;
    const cands = real().filter(([, v]) => fits(v, props[target]!));
    if (cands.length === 1) {
      const [k, v] = cands[0]!;
      out[target] = coerce(v, props[target]!);
      note(`参数 ${k} 当作 ${target}`);
      rest = rest.filter(([x]) => x !== k);
    }
  }
  const unknown: string[] = [];
  for (const [k, v] of rest) {
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    const dup = empty || SIDE_EFFECT.has(name) || typeof v === "number" || typeof v === "boolean" ? undefined : Object.keys(out).find((p) => same(coerce(v, props[p] ?? {}), out[p]));
    if (dup !== undefined) note(`去掉了和 ${dup} 一样的参数 ${k}`);
    else if (NOISE.has(norm(k))) noise.push(k);
    else unknown.push(k);
  }
  if (noise.length > 0) note(`${name} 没有参数 ${noise.join("、")}，忽略了`);
  const lack = missing();
  if (lack.length > 0) throw new Fail(`${name} 缺参数 ${lack.join("、")}${unknown.length > 0 ? `；不认识的参数：${unknown.join("、")}` : ""}。${usage(name)}`);
  return { args: out, unknown };
}

/** 只读的工具：不认识的参数丢掉并说明。 */
export function dropUnknown(name: string, unknown: string[], tail = ""): void {
  if (unknown.length > 0) note(`${name} 没有参数 ${unknown.join("、")}，忽略了${tail}`);
}

/**
 * 会改东西的工具：不认识的参数可能改语义（dry_run、overwrite:false），丢掉会做错事，所以拒绝。
 * `effect` 写清照抄“去掉再调”会做什么，给的下一步不能比模型原来想做的更危险；不给就写通用的一句。
 */
export function refuseUnknown(name: string, unknown: string[], effect?: string): void {
  const list = unknown.join("、");
  if (unknown.length > 0) throw new Fail(`${name} 没有参数 ${list}。${usage(name)}。${effect ?? `${list} 的效果 ${name} 没有；去掉 ${list} 再调，就是照剩下的参数真的执行 ${name}，不会有 ${list} 想要的效果。`}`);
}

/** 一段文字最多留 `max` 个字符，多的写明总数。 */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字，已截）`;
}
