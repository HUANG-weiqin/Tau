// tx 的参数：退出码、选项解析、路径转换、从标准输入读正文。不导入 src/。
import path from "node:path";

/** 命令要以这个退出码结束，`message` 写到标准错误。 */
export class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** 用法错误：退出码 2，请求没发出。 */
export const usage = (message: string): Exit => new Exit(2, message);

export interface Spec {
  /** 不带值的选项，例如 `any`。 */
  flags?: string[];
  /** 带一个值的选项，例如 `id`。 */
  values?: string[];
  /** 带一个值、可以重复的选项，例如 `image`。 */
  multi?: string[];
}

export interface Parsed {
  flags: Set<string>;
  values: Map<string, string>;
  multi: Map<string, string[]>;
  /** 位置参数。 */
  rest: string[];
}

/**
 * 选项写在位置参数之前；`--` 结束选项。第一个位置参数之后，任何一个参数等于已知选项、
 * 或者以“已知选项=”开头，都是用法错误：它多半是选项写错了位置，悄悄当正文会发出去错的请求。
 */
export function parse(argv: string[], spec: Spec): Parsed {
  const flags = new Set(spec.flags ?? []);
  const values = new Set(spec.values ?? []);
  const multi = new Set(spec.multi ?? []);
  const out: Parsed = { flags: new Set(), values: new Map(), multi: new Map(), rest: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("--")) break;
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (flags.has(name)) {
      if (eq >= 0) throw usage(`选项 --${name} 不带值。`);
      out.flags.add(name);
    } else if (values.has(name) || multi.has(name)) {
      let v: string | undefined = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw usage(`选项 --${name} 要带一个值。`);
      if (multi.has(name)) out.multi.set(name, [...(out.multi.get(name) ?? []), v]);
      else out.values.set(name, v);
    } else throw usage(`不认识的选项 ${a.slice(0, eq < 0 ? undefined : eq)}。用 tx help 看用法。`);
  }
  out.rest = argv.slice(i);
  const known = [...flags, ...values, ...multi];
  for (const a of out.rest.slice(1)) {
    const hit = known.find((n) => a === `--${n}` || a.startsWith(`--${n}=`));
    if (hit !== undefined) throw usage(`选项 --${hit} 写在了位置参数后面。选项要挪到位置参数前面；正文里真要写这几个字，和别的字放进同一个参数（加引号）。`);
  }
  return out;
}

/** 整数选项：给了就必须是不小于 `min` 的整数。 */
export function intOpt(p: Parsed, name: string, min: number): number | undefined {
  const v = p.values.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n) || n < min) throw usage(`--${name} 要是不小于 ${min} 的整数，收到“${v}”。`);
  return n;
}

const CYGPATH = "用 cygpath -w 转成 Windows 路径再传，例如 --workdir \"$(cygpath -w /tmp/x)\"。";

/**
 * `C:\x`、`C:/x`、Git Bash 的 `/c/x` 和 UNC 路径转成 Windows 绝对路径；相对路径按 `cwd` 解析；
 * 其它以 `/` 开头的路径（例如 `/tmp`）是用法错误：只有 Git Bash 里的 cygpath 知道它在哪。
 */
export function winPath(raw: string, cwd: string): string {
  const s = raw.trim();
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s)) return path.win32.normalize(s);
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
  if (m) return path.win32.normalize(`${m[1]!.toUpperCase()}:${m[2] ?? "/"}`);
  if (s === "") throw usage("路径是空的。");
  if (/^[/\\]/.test(s)) throw usage(`路径 ${s} 以 / 开头，但不是 /c/x 这种盘符路径，tx 不知道它在哪。${CYGPATH}`);
  return path.win32.resolve(cwd, s);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF+/, "");
}

/** 正文：其余参数用一个空格连接；正好是 `-` 时读标准输入（去掉末尾的换行）。空的是用法错误。 */
export async function bodyOf(parts: string[], what = "消息"): Promise<string> {
  let text = parts.join(" ");
  if (text === "-") text = (await readStdin()).replace(/(\r?\n)+$/, "");
  if (text.trim() === "") throw usage(`${what}是空的。写在命令行上，或者用 - 从标准输入读。`);
  return text;
}

/** 进程 ID：按逗号和空白拆开，转小写（协议只许小写），去重。真转了就在标准错误说一句。 */
export function ids(raw: string[]): string[] {
  const out: string[] = [];
  for (const x of raw.flatMap((s) => s.split(/[\s,，、]+/)).filter((s) => s !== "")) {
    const low = x.toLowerCase();
    if (low !== x) process.stderr.write(`注：进程 ID ${x} 当作 ${low}（ID 只许小写）\n`);
    if (!out.includes(low)) out.push(low);
  }
  return out;
}
