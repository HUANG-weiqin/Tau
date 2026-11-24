// tx 的命令。每个命令返回退出码，出错抛 Exit。只用线协议和上层的小件，不导入 src/。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listPresets } from "../tools/list_presets.ts";
import { describe } from "../tools/peek.ts";
import { presetsDir } from "../tools/presets.ts";
import { phaseText } from "../tools/wait.ts";
import { Exit, bodyOf, ids, intOpt, parse, usage, winPath } from "./args.ts";
import { ask, idHint, receipt, withIdHint } from "./net.ts";

export interface Ctx {
  pipe: string;
  cwd: string;
}

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);
const ID_RE = /^[0-9a-z][0-9a-z_-]{0,31}$/;
const DEFAULT_WAIT_SECONDS = 100;
const DEFAULT_LAST = 20;

/** 自己生成进程 ID：连接断了、结果未知时，调用方还有 ID 能查。 */
const genId = (): string => `t${randomBytes(5).toString("hex")}`;

function checkId(id: string): string {
  if (!ID_RE.test(id)) throw usage(`进程 ID 只许小写字母、数字、下划线和连字符，以字母或数字开头，最多 32 个字符，收到“${id}”。`);
  return id;
}

function oneId(rest: string[], what: string): string {
  const all = ids(rest);
  if (all.length !== 1) throw usage(`${what}要正好一个进程 ID。`);
  return all[0]!;
}

function images(paths: string[] | undefined, cwd: string): string[] | undefined {
  if (paths === undefined) return undefined;
  return paths.map((raw) => {
    const p = winPath(raw, cwd);
    try {
      return readFileSync(p).toString("base64");
    } catch (e) {
      throw usage(`读不出图片 ${p}：${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** 预设拼错了，列出现有的。 */
async function presetHint(preset: string): Promise<string> {
  if (existsSync(path.join(presetsDir(), `${preset}.md`))) return "";
  const ids = (await listPresets(presetsDir()).catch(() => [])).map((r) => r.id);
  return ids.length > 0 ? `\n没有预设 ${preset}。现有的预设：${ids.join("、")}。` : `\n没有预设 ${preset}，~/.tau/presets 里也没有预设文件。`;
}

// ---------- 文字格式 ----------

export function endedLabel(e: unknown): string {
  if (e === "done") return "正常结束";
  if (e === "stepLimit") return "步数用完";
  if (e === "stopped") return "被停止";
  if (typeof e === "object" && e !== null && "error" in e) return `出错：${String((e as { error: unknown }).error)}`;
  return "结束了";
}

/** 最终回复：从末尾往前找，先遇到用户消息是空串，先遇到助手消息把它的 text 块直接连起来，工具结果跳过（kb-kernel 的“最终回复”）。 */
export function finalOf(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return "";
    if (m?.role === "assistant") return (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
  }
  return "";
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  if (s < 86400) return `${(Math.floor(s / 360) / 10).toFixed(1)}时`;
  return `${(Math.floor(s / 8640) / 10).toFixed(1)}天`;
}

/** 一个进程一行：比 `tau ps` 多父进程、模型、排队数、后台命令数、在跑的子进程数。`kids` 是在跑的子进程数（投影的 `children` 的个数）。 */
export function psLine(p: any, kids = 0): string {
  const ph = p.phase;
  const phase = ph.tag === "idle" ? `idle${ph.ended === undefined ? "" : `(${typeof ph.ended === "string" ? ph.ended : "error"})`}` : ph.tag === "awaitingModel" ? `${ph.purpose === "handoff" ? "换段中" : "等模型"} 第${ph.steps}步` : `等工具 第${ph.steps}步`;
  return [
    p.id, p.preset, phase, `${k(p.context.used)}/${k(p.context.window)}`, `段${p.segment}`, ago(p.age),
    `父 ${p.parent ?? "-"}`, `模型 ${p.model}`, `排队 ${ph.tag === "idle" ? 0 : ph.queued}`, `后台 ${p.bgJobs?.length ?? 0}`, `子进程 ${kids}`,
  ].join("  ");
}

// ---------- 读段和订阅 ----------

interface Segment {
  rows: { seq: number; message: any }[];
  segment: number;
  messages: number;
}

/** 读一段：不给段号就是当前段。 */
async function readSegment(pipe: string, id: string, segment?: number): Promise<Segment> {
  const rows: Segment["rows"] = [];
  let end: { segment: number; messages: number } | null = null;
  let error: string | null = null;
  await ask(pipe, { op: "history", process: id, ...(segment === undefined ? {} : { segment }) }, (r) => {
    if (r.type === "message") rows.push({ seq: r.seq, message: r.message });
    else if (r.type === "end") end = { segment: r.segment, messages: r.messages };
    else if (r.type === "error") error = String(r.message);
    return end !== null || error !== null;
  }, "history 是只读的，可以重发。");
  if (error !== null) return withIdHint(pipe, new Exit(1, error));
  if (end === null) throw new Exit(3, "服务没读完就断开了，可以重发。");
  return { rows, ...(end as { segment: number; messages: number }) };
}

/** 全部进程的投影（`ps`）。 */
async function allProcs(pipe: string): Promise<any[]> {
  let procs: any[] | undefined;
  let error: string | null = null;
  await ask(pipe, { op: "ps" }, (r) => {
    if (r.type === "ps") procs = r.processes;
    else if (r.type === "error") error = String(r.message);
    return procs !== undefined || error !== null;
  }, "ps 是只读的，可以重发。");
  if (error !== null) throw new Exit(1, error);
  if (procs === undefined) throw new Exit(3, "服务没回快照就断开了，可以重发。");
  return procs;
}

/** 一个进程的 `self`，和它在跑的子进程数。找不到是退出码 1，列候选。 */
async function lookup(pipe: string, id: string): Promise<{ self: any; kids: number }> {
  const mine = (await allProcs(pipe)).find((x) => x.self.id === id);
  if (mine === undefined) return withIdHint(pipe, new Exit(1, `没有这个进程：${id}`));
  return { self: mine.self, kids: mine.children?.length ?? 0 };
}

/** 这一轮停了以后还会唤醒它的事：后台命令和子进程。 */
function pendingText(bg: number, kids: number): string {
  return [bg > 0 ? `${bg} 个后台命令` : "", kids > 0 ? `${kids} 个子进程` : ""].filter((s) => s !== "").join("、");
}

// ---------- 命令 ----------

async function start(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { values: ["id", "workdir"], multi: ["image"] });
  const [preset, ...task] = p.rest;
  if (preset === undefined) throw usage("tx start 要预设和任务：tx start [--id X] [--workdir D] [--image P]... <预设> <任务|->。预设用 tx presets 看。");
  const id = checkId(p.values.get("id") ?? genId());
  const text = await bodyOf(task, "任务");
  const workdir = p.values.get("workdir");
  const imgs = images(p.multi.get("image"), c.cwd);
  const req = { op: "start", preset, text, id, ...(workdir === undefined ? {} : { workdir: winPath(workdir, c.cwd) }), ...(imgs === undefined ? {} : { images: imgs }) };
  try {
    await receipt(c.pipe, req, `进程 ID 是 ${id}：用 tx ps ${id} 查它有没有建好，建好了就接着用，不要重发。`);
  } catch (e) {
    if (e instanceof Exit && e.code === 3) err(`进程 ID 是 ${id}\n`);
    if (e instanceof Exit && e.code === 1) throw new Exit(1, `${e.message}${await presetHint(preset)}`);
    throw e;
  }
  out(`${id}\n`);
  return 0;
}

async function post(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { flags: ["handoff"], multi: ["image"] });
  const [rawProc, ...msg] = p.rest;
  if (rawProc === undefined) throw usage("tx post 要进程和消息：tx post [--image P]... [--handoff] <进程> <消息|->。");
  const proc = oneId([rawProc], "tx post ");
  const text = await bodyOf(msg);
  const imgs = images(p.multi.get("image"), c.cwd);
  const req = { op: "send", process: proc, text, ...(p.flags.has("handoff") ? { handoff: true } : {}), ...(imgs === undefined ? {} : { images: imgs }) };
  await receipt(c.pipe, req, `用 tx ps ${proc} 看信有没有到：进程在运行，再发一遍会多一封。`).catch((e) => withIdHint(c.pipe, e));
  out(`已寄给 ${proc}\n`);
  return 0;
}

/** stop 和 rm：对每个进程发一个请求，失败的汇总到最后。 */
function each(op: "stop" | "remove", done: string) {
  return async (argv: string[], c: Ctx): Promise<number> => {
    const p = parse(argv, {});
    const failed: string[] = [];
    let code = 1;
    const targets = ids(p.rest);
    if (targets.length === 0) throw usage(`tx ${op === "stop" ? "stop" : "rm"} 要至少一个进程 ID。`);
    for (const id of targets) {
      try {
        await receipt(c.pipe, { op, process: id }, `用 tx ps ${id} 看结果。`);
        out(`${done} ${id}\n`);
      } catch (e) {
        if (!(e instanceof Exit) || e.code === 2) throw e;
        if (e.code === 3) code = 3;
        failed.push(`${id}：${e.message}`);
      }
    }
    if (failed.length > 0) throw new Exit(code, `${failed.join("\n")}\n${await idHint(c.pipe)}`);
    return 0;
  };
}

async function fork(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { values: ["before", "preset", "id"] });
  const proc = oneId(p.rest, "tx fork ");
  const before = intOpt(p, "before", 0);
  const id = checkId(p.values.get("id") ?? genId());
  const preset = p.values.get("preset");
  const req = { op: "fork", process: proc, id, ...(before === undefined ? {} : { before }), ...(preset === undefined ? {} : { preset }) };
  try {
    await receipt(c.pipe, req, `新进程的 ID 是 ${id}：用 tx ps ${id} 查它有没有建好，不要重发。`);
  } catch (e) {
    if (e instanceof Exit && e.code === 3) err(`进程 ID 是 ${id}\n`);
    return withIdHint(c.pipe, e);
  }
  out(`${id}\n`);
  return 0;
}

interface Seen {
  preset?: string;
  phase?: any;
  gone?: boolean;
  /** 后台命令数（`self.bgJobs`）。 */
  bg: number;
  /** 在跑的子进程数；还没查到是 undefined。只在这一轮停了、没有后台命令时才查。 */
  kids?: number;
}

/** 这一轮停了（带结束原因的 idle），而且没有后台命令在跑。 */
const stopped = (s: Seen): boolean => s.phase !== undefined && phaseText(s.phase).ended && s.bg === 0;
/** 结束：被删了，或者停了、没有后台命令、也没有子进程在跑。 */
const finished = (s: Seen): boolean => s.gone === true || (stopped(s) && s.kids === 0);
const KIDS_POLL_MS = 1000;

/** 没结束的状态：停了但还有后台命令或子进程，写清楚，不然写阶段。 */
function statusOf(s: Seen): string {
  if (s.phase === undefined) return "还没读到";
  const t = phaseText(s.phase);
  const pend = pendingText(s.bg, s.kids ?? 0);
  if (t.ended && pend !== "") return `这一轮停了，但还有 ${pend}在跑，跑完会唤醒它`;
  if (t.ended) return "这一轮停了，还在确认有没有子进程在跑";
  return t.text;
}

async function wait(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { flags: ["any"], values: ["timeout"] });
  const targets = ids(p.rest);
  if (targets.length === 0) throw usage("tx wait 要至少一个进程 ID：tx wait [--any] [--timeout 秒] <进程>...。");
  const seconds = intOpt(p, "timeout", 1) ?? DEFAULT_WAIT_SECONDS;
  const any = p.flags.has("any");
  const seen = new Map<string, Seen>(targets.map((id) => [id, { bg: 0 }]));
  const unread = (): boolean => targets.some((id) => seen.get(id)!.phase === undefined && seen.get(id)!.gone !== true);
  const enough = (): boolean => (any ? targets.some((id) => finished(seen.get(id)!)) : targets.every((id) => finished(seen.get(id)!)));
  const ctl = new AbortController();
  let satisfied = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const missing: string[] = [];
  let failure: Exit | null = null;
  /** 够了，但有的进程还没读到状态：最多再等 1 秒让它们读到，输出里就不会写“还没读到”。 */
  const check = (): void => {
    if (!enough()) return;
    satisfied = true;
    if (!unread()) ctl.abort();
    else grace ??= setTimeout(() => ctl.abort(), 1000);
  };
  /** 查在跑的子进程数（投影里的 `children`：parent 是它、不处于 idle）。 */
  const asking = new Set<string>();
  const refreshKids = (id: string): void => {
    if (asking.has(id) || ctl.signal.aborted) return;
    asking.add(id);
    lookup(c.pipe, id).then(({ kids }) => {
      const s = seen.get(id)!;
      if (stopped(s)) s.kids = kids;
      check();
    }, (e: Exit) => {
      failure ??= e;
      ctl.abort();
    }).finally(() => asking.delete(id));
  };
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  /** 停了但还有子进程时，子进程结束不一定有信给它：隔一会儿再查。 */
  const poll = setInterval(() => {
    for (const id of targets) if (stopped(seen.get(id)!) && (seen.get(id)!.kids ?? 0) > 0) refreshKids(id);
  }, KIDS_POLL_MS);
  await Promise.all(targets.map((id) => ask(c.pipe, { op: "watch", process: id }, (r) => {
    const s = seen.get(id)!;
    if (r.type === "update") {
      s.phase = r.self?.phase;
      s.preset = r.self?.preset;
      s.bg = r.self?.bgJobs?.length ?? 0;
      s.kids = undefined;
      if (stopped(s)) refreshKids(id);
    } else if (r.type === "removed") s.gone = true;
    else if (r.type === "error") {
      if (String(r.message).startsWith("没有这个进程")) missing.push(id);
      else failure ??= new Exit(1, String(r.message));
      ctl.abort();
      return true;
    }
    check();
    return false;
  }, "wait 只读，可以重发。", ctl.signal).catch((e: Exit) => {
    failure ??= e;
    ctl.abort();
  })));
  clearTimeout(timer);
  clearTimeout(grace);
  clearInterval(poll);
  if (failure !== null) throw failure;
  if (missing.length > 0) throw new Exit(1, `这些不是现有的进程 ID：${missing.join("、")}。拼错了就照下面的改；如果它已经被删除，不用再等。\n${await idHint(c.pipe)}`);
  if (!satisfied && !ctl.signal.aborted) throw new Exit(3, "服务断开了，可以重发。");
  const parts = await Promise.all(targets.map(async (id) => {
    const s = seen.get(id)!;
    const head = `## ${id}（${s.preset ?? "?"}）`;
    if (s.gone) return `${head}已被删除`;
    if (!finished(s)) return `${head}\n状态：${statusOf(s)}`;
    const reply = await readSegment(c.pipe, id).then((seg) => finalOf(seg.rows.map((r) => r.message))).catch((e: Error) => `（读不到回复：${e.message}）`);
    return `${head}${endedLabel(s.phase.ended)}\n${reply === "" ? "（没有回复文字）" : reply}`;
  }));
  out(`${parts.join("\n\n")}\n`);
  if (satisfied) return 0;
  err(`等了 ${seconds} 秒，${any ? "还没有进程结束" : "还没全部结束"}。可以再 tx wait，或者先做别的。\n`);
  return 4;
}

async function result(argv: string[], c: Ctx): Promise<number> {
  const id = oneId(parse(argv, {}).rest, "tx result ");
  const { self, kids } = await lookup(c.pipe, id);
  const t = phaseText(self.phase);
  if (!t.ended) {
    err(`进程 ${id} 还没有结果：${t.text}。用 tx wait ${id} 等。\n`);
    return 4;
  }
  const seg = await readSegment(c.pipe, id);
  const reply = finalOf(seg.rows.map((r) => r.message));
  if (reply !== "") out(`${reply}\n`);
  const bg = self.bgJobs?.length ?? 0;
  if (bg > 0 || kids > 0) {
    err(`回复可能还会变：这一轮停了，但还有 ${pendingText(bg, kids)}在跑，跑完会唤醒它。用 tx wait ${id} 等。\n`);
    return 4;
  }
  if (self.phase.ended === "done") return 0;
  err(`[本轮结束：${endedLabel(self.phase.ended)}]\n`);
  return 1;
}

async function ps(argv: string[], c: Ctx): Promise<number> {
  const want = ids(parse(argv, {}).rest);
  const procs = await allProcs(c.pipe);
  const rows = want.length === 0 ? procs : want.map((id) => procs.find((x) => x.self.id === id) ?? id);
  const bad = rows.filter((r): r is string => typeof r === "string");
  if (bad.length > 0) throw new Exit(1, `没有这些进程：${bad.join("、")}。\n${await idHint(c.pipe)}`);
  out(rows.length === 0 ? "没有进程。\n" : `${rows.map((x) => psLine(x.self, x.children?.length ?? 0)).join("\n")}\n`);
  return 0;
}

async function history(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { values: ["segment", "last"] });
  const id = oneId(p.rest, "tx history ");
  const segment = intOpt(p, "segment", 1);
  const last = intOpt(p, "last", 1) ?? DEFAULT_LAST;
  const seg = await readSegment(c.pipe, id, segment);
  const rows = seg.rows.slice(-last);
  if (rows.length === 0) out(`进程 ${id} 的第 ${seg.segment} 段还没有消息。\n`);
  else out(`进程 ${id}，第 ${seg.segment} 段共 ${seg.messages} 条，最后 ${rows.length} 条（--last 改条数，--segment 选段）：\n\n${rows.map(describe).join("\n\n")}\n`);
  return 0;
}

async function presets(argv: string[]): Promise<number> {
  parse(argv, {});
  const rows = await listPresets(presetsDir()).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  out(rows.length === 0 ? "没有预设。预设是 ~/.tau/presets/<id>.md，直接写文件。\n" : `${rows.map((r) => `${r.id}  ${r.summary === "" ? "（正文是空的）" : r.summary}`).join("\n")}\n`);
  return 0;
}

/** 任意线协议请求：回复一行一行原样写出，直到服务关闭连接；`--timeout` 到点截断（给 watch 用）。 */
async function req(argv: string[], c: Ctx): Promise<number> {
  const p = parse(argv, { values: ["timeout"] });
  const seconds = intOpt(p, "timeout", 1);
  const text = await bodyOf(p.rest, "请求");
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    throw usage("请求不是合法的 JSON。例子：tx req '{\"op\":\"ps\"}'");
  }
  if (typeof request !== "object" || request === null || Array.isArray(request) || typeof (request as { op?: unknown }).op !== "string") throw usage("请求要是带 op 的 JSON 对象。例子：tx req '{\"op\":\"ps\"}'");
  const ctl = new AbortController();
  const timer = seconds === undefined ? undefined : setTimeout(() => ctl.abort(), seconds * 1000);
  let replies = 0;
  let errors = 0;
  await ask(c.pipe, request as Record<string, unknown>, (r) => {
    replies++;
    if (r?.type === "error") errors++;
    out(`${JSON.stringify(r)}\n`);
  }, "请求可能已经提交。先查状态再决定要不要重发。", ctl.signal);
  clearTimeout(timer);
  if (ctl.signal.aborted) return 4;
  if (replies === 0) throw new Exit(3, "连接关了，没收到回复，结果未知。请求可能已经提交：先查状态再决定要不要重发。");
  return errors > 0 ? 1 : 0;
}

export const COMMANDS: Record<string, (argv: string[], c: Ctx) => Promise<number>> = {
  start,
  post,
  wait,
  result,
  ps,
  history,
  stop: each("stop", "已发出停止"),
  rm: each("remove", "已删除"),
  fork,
  presets,
  req,
};
