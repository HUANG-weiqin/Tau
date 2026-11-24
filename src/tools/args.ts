// 弱模型填参数常出错。库内和库外的内置工具共用这一处整理；意图唯一就照做，说明交给调用方接在结果后面（见 .knowledge/kb-tools.md「参数从哪来」）。
import { BG_START } from "../kernel/observe.ts";
import type { ToolCall, ToolResultContent } from "../kernel/types.ts";

type Schema = { properties?: Record<string, { type?: string }>; required?: readonly string[] };
type Spec = { name: string; parameters: object };
export type Fixed = { args: Record<string, unknown>; notes: string[] } | { error: string };

const TYPES: Record<string, string> = { string: "字符串", integer: "整数", boolean: "布尔值", number: "数", array: "数组", object: "对象" };
/** 别家 harness 带来的说明性参数（归一以后的写法）：在内置工具里没有作用，丢掉。 */
const NOISE = ["description", "explanation", "reason", "title", "summary", "note", "requiresapproval", "restart", "shouldreadentirefile", "isbackground", "runinbackground"];
/** 别名表：只收别家 harness 里有出处的写法（不按“只多一个”去猜，猜错会寄错信、写错记忆、跑错命令）。只填必填、而且名字正好对上的键放完以后还空着的参数；写法先过 norm 再比。 */
const ALIAS: Record<string, string[]> = {
  path: ["file", "targetfile", "absolutepath"], content: ["text", "codecontent"], value: ["content"], brief: ["description", "summary"], text: ["message", "content", "prompt", "body", "task"],
  to: ["proces", "recipient"], preset: ["subagenttype"], command: ["cmd", "script"], process: ["processid", "id", "pid"], key: ["name"],
};
/** 这些参数由工具自己处理：缺了、是 null、不是整数都不在这里报错（D109，记忆分支）。 */
const LENIENT: Record<string, string[]> = { memory_set: ["brief", "version"], memory_edit: ["version"], memory_delete: ["version"] };

/** 参数名归一：不分大小写，去掉空白、`_`、`-` 和末尾的数字，去掉开头的 file 和末尾的 string、str、text、s。 */
const norm = (k: string): string => k.toLowerCase().replace(/[\s_-]|\d+$/g, "").replace(/^file(?=.)/, "").replace(/(?<=.)(?:string|str|text|s)$/, "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const what = (v: unknown): string => (Array.isArray(v) ? "数组" : isObj(v) ? "对象" : JSON.stringify(v).slice(0, 40));

function parse(v: string, t: string): unknown {
  try {
    const p: unknown = JSON.parse(v);
    return (t === "array" ? Array.isArray(p) : isObj(p)) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** 参数表和调用的样子，接在参数错误后面。 */
export function usage({ name, parameters }: Spec): string {
  const { properties = {}, required = [] } = parameters as Schema;
  const list = Object.entries(properties).map(([k, p]) => `${k}（${TYPES[p.type ?? ""] ?? "见说明"}，${required.includes(k) ? "必填" : "可选"}）`);
  return `${name} 的参数：${list.join("、") || "无"}。照这样调用：${name}({${required.map((k) => `"${k}": …`).join(", ")}})`;
}

/** 兜底照做的说明：另起一行“注：…。”接在最后一个文本块后面，几处用分号连成一行；没有文本块就加一块。isError 不动。转后台的 bash 结果不加：固定的一段必须留在末尾（observe.ts 的 BG_START）。 */
export function noted<T extends ToolResultContent>(r: T, notes: readonly string[]): T {
  const i = r.content.findLastIndex((b) => b.type === "text");
  const last = r.content[i];
  if (notes.length === 0 || (last?.type === "text" && BG_START.test(last.text))) return r;
  const line = `注：${notes.join("；")}。`;
  const content = [...r.content];
  const old = last;
  if (old?.type === "text") content[i] = { type: "text", text: old.text === "" ? line : `${old.text}\n${line}` };
  else content.push({ type: "text", text: line });
  return { ...r, content };
}

/** 内置工具的标量：整数不截小数（版本号是乐观锁），布尔认 true/false、yes/no、y/n、1/0，不分大小写。转不了是 undefined。 */
function cast(type: string | undefined, v: unknown): unknown {
  const s = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  if (type === "string") return typeof v === "string" ? v : s;
  if (type === "integer") return s !== undefined && /^-?\d+(\.0*)?$/.test(s) ? Number(s) : undefined;
  return type !== "boolean" ? v : /^(true|yes|y|1)$/.test(s ?? "") ? true : /^(false|no|n|0)$/.test(s ?? "") ? false : undefined;
}

/**
 * 整理一次调用的参数，返回修好的参数和兜底的说明，或者整段错误文字（带“参数错误：”）。
 * 内置工具做全套：归一、别名、同值的副本、说明性参数、标量；之后类型都对、必填的都在、没有多余的（LENIENT 里的除外）。
 * 工具定义按契约只修 null 和字符串化的数组、对象，其余交给 schema 校验。
 */
export function fixArgs(spec: Spec, call: Pick<ToolCall, "arguments" | "argumentsError">, builtin: boolean): Fixed {
  const { properties = {}, required = [] } = spec.parameters as Schema;
  const names = Object.keys(properties);
  const lenient = builtin ? LENIENT[spec.name] ?? [] : [];
  if (call.argumentsError !== undefined) {
    if (builtin && names.length === 0) return { args: {}, notes: ["参数不是合法的 JSON，没用上"] };
    return { error: `参数错误：参数不是一个合法的 JSON 对象。重发时写成一个对象：键和字符串都用双引号，字符串里的双引号写成 \\"，反斜杠写成 \\\\；不要把整个参数再包成字符串，不要加 \`\`\`，一次调用只放一个对象。${usage(spec)}` };
  }
  const notes: string[] = [];
  const bad: string[] = [];
  // 没有原型的对象：叫 __proto__ 的参数也是普通的键。名字正好是参数名的先放，归一和别名的后放。
  const args: Record<string, unknown> = Object.create(null);
  const extra: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(isObj(call.arguments) ? call.arguments : {}).sort(([a], [b]) => Number(!names.includes(a)) - Number(!names.includes(b)))) {
    const to = !builtin || names.includes(k) ? k : names.find((n) => norm(n) === norm(k) || (required.includes(n) && !(n in args) && ALIAS[n]?.includes(norm(k))));
    if (v === null && (!required.includes(to ?? "") || lenient.includes(to ?? ""))) continue; // 可选的 null 当没填
    if (to === undefined) extra[k] = v;
    else if (!(to in args)) {
      args[to] = v;
      if (to !== k) notes.push(`参数 ${k} 当作 ${to}`);
    } else if (args[to] === v) notes.push(`参数 ${k} 重复，没用上`);
    else bad.push(`${to} 给了两次，值不一样`);
  }
  // bash 的工作目录键（cwd、workdir 等）：命令前加一句 cd，值原样交给 bash，路径写法由它解析。失败就不跑原命令。
  const dir = spec.name === "bash" && typeof args.command === "string" ? Object.keys(extra).find((k) => ["workdir", "cwd", "directory", "dirpath"].includes(norm(k)) && typeof extra[k] === "string") : undefined;
  if (dir !== undefined) {
    args.command = `cd -- '${String(extra[dir]).replaceAll("'", "'\\''")}' || exit\n${args.command}`;
    notes.push(`参数 ${dir} 当作命令前的 cd -- '${extra[dir]}'`);
    delete extra[dir];
  }
  // 丢掉：说明性的；值等于工具名或某个已给的字符串参数的（同值的副本）；没有参数的工具（self、handoff）的全部多余参数。
  const given: unknown[] = Object.values(args).filter((v) => typeof v === "string");
  const drop = Object.keys(extra).filter((k) => names.length === 0 || NOISE.includes(norm(k)) || extra[k] === spec.name || given.includes(extra[k]));
  if (drop.length > 0) notes.push(`没用上参数 ${drop.join("、")}`);
  for (const k of drop) delete extra[k];
  for (const [k, v] of Object.entries(args)) {
    const type = properties[k]?.type;
    if (v === null) bad.push(`${k} 是 null，必填${type === "string" ? "（空的写 \"\"）" : ""}`);
    else if (!builtin) {
      const p = (type === "array" || type === "object") && typeof v === "string" ? parse(v, type) : undefined;
      if (p !== undefined) args[k] = p;
    } else if (type !== "string" && typeof v === "string" && /^\s*(null|none|undefined)?\s*$/i.test(v) && (!required.includes(k) || lenient.includes(k))) delete args[k];
    else if (cast(type, v) !== undefined) args[k] = cast(type, v);
    else if (!lenient.includes(k) || type === "string") bad.push(`${k} 要${TYPES[type ?? ""]}，收到的是 ${what(v)}`);
  }
  if (Object.keys(extra).length > 0) bad.push(`不认识参数 ${Object.keys(extra).join("、")}${spec.name === "write" ? "（write 总是整份覆盖。要追加，用 bash：cat >> 文件 <<'EOF'；文件已存在就不写，用 bash：set -C; cat > 文件 <<'EOF'）" : ""}`);
  const lack = builtin ? required.filter((r) => !(r in args) && !lenient.includes(r)) : [];
  if (lack.length > 0) bad.push(`缺少 ${lack.join("、")}`);
  return bad.length > 0 ? { error: `参数错误：${bad.join("；")}。${usage(spec)}` } : { args: { ...args }, notes };
}
