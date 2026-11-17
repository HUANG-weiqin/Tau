// 预设的列出和新建、删除。读预设不自己解析：经管道问服务的 `check`，读得出、能不能启动、错误文字都和 `start` 一致。
// 这里只写文件，不导入 src/。
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { HttpError, isAbsoluteWinPath } from "./util.ts";

const THINKING = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CHECK_TIMEOUT_MS = 10_000;

export interface PresetOk {
  id: string;
  ok: true;
  workdir: string;
  model: string;
  tools: string[];
  memory: boolean;
  thinking?: string;
  handoff?: number;
  options?: Record<string, unknown>;
}
export type PresetInfo = PresetOk | { id: string; ok: false; error: string };

/** 问服务一次 `check`。回 `check` 行，或者 `error` 的原文。连不上抛 503。 */
function check(pipe: string, id: string): Promise<{ snapshot: any; error: string | null } | { fail: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let buf = "";
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      f();
    };
    const timer = setTimeout(() => finish(() => reject(new HttpError(504, "tau 服务没有回应 check"))), CHECK_TIMEOUT_MS);
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "check", preset: id })}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let r: any;
      try {
        r = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(() => reject(new HttpError(502, "tau 服务回的不是 JSON")));
      }
      if (r.type === "check") finish(() => resolve({ snapshot: r.snapshot, error: typeof r.error === "string" ? r.error : null }));
      else if (r.type === "error") finish(() => resolve({ fail: String(r.message) }));
      else finish(() => reject(new HttpError(502, "tau 服务回了意外的内容")));
    });
    socket.on("error", () => finish(() => reject(new HttpError(503, "连不上 tau 服务，先运行 tau serve"))));
    socket.on("close", () => finish(() => reject(new HttpError(503, "tau 服务在回复前断开了"))));
  });
}

/** 一个预设此刻读成什么。读不出或者装不下，都是 `ok: false`，文字和 `start` 的一样。 */
export async function presetInfo(pipe: string, id: string): Promise<PresetInfo> {
  const r = await check(pipe, id);
  if ("fail" in r) return { id, ok: false, error: r.fail };
  if (r.error !== null) return { id, ok: false, error: r.error };
  const s = r.snapshot;
  const tools: string[] = [...s.tools, ...s.toolDefs.map((d: { name: string }) => d.name)];
  return {
    id,
    ok: true,
    workdir: s.workdir,
    model: s.model,
    tools,
    memory: tools.includes("memory"),
    ...(s.thinking === undefined ? {} : { thinking: s.thinking }),
    ...(s.handoff === undefined ? {} : { handoff: s.handoff }),
    ...(s.options === undefined ? {} : { options: s.options }),
  };
}

/** `presets/` 下每个 `.md` 一项，按 ID 排序。没有目录是空列表。 */
export async function listPresets(home: string, pipe: string): Promise<PresetInfo[]> {
  let names: string[];
  try {
    names = readdirSync(path.join(home, "presets"));
  } catch {
    return [];
  }
  const ids = names.filter((n) => n.endsWith(".md")).sort().map((n) => n.slice(0, -3));
  return Promise.all(ids.map((id) => presetInfo(pipe, id)));
}

export async function presetWorkdirs(home: string, pipe: string): Promise<string[]> {
  return (await listPresets(home, pipe)).flatMap((p) => (p.ok ? [p.workdir] : []));
}

function line(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || /[\r\n]/.test(v)) throw new HttpError(400, `${name} 必须是单行的非空字符串`);
  return v.trim();
}

function presetId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw) || /^\.+$/.test(raw) || raw.endsWith(".")) throw new HttpError(400, "预设 ID 只许字母、数字、点、下划线和连字符");
  return raw;
}

export function createPreset(home: string, body: Record<string, unknown>): void {
  const id = presetId(body.id);
  const workdir = line("workdir", body.workdir);
  if (!isAbsoluteWinPath(workdir)) throw new HttpError(400, "工作目录必须是绝对路径");
  try {
    if (!statSync(workdir).isDirectory()) throw new Error();
  } catch {
    throw new HttpError(400, "工作目录不存在");
  }
  const model = line("model", body.model);
  if (!/^[^/\s]+\/\S+$/.test(model)) throw new HttpError(400, "模型格式应为 <provider>/<model-id>");
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !/^[A-Za-z0-9._-]+$/.test(t))) throw new HttpError(400, "tools 必须是名字的数组");
  const head = [`workdir: ${workdir}`, `model: ${model}`, `tools: ${tools.join(", ")}`];
  if (body.thinking !== undefined) {
    if (typeof body.thinking !== "string" || !THINKING.includes(body.thinking)) throw new HttpError(400, `thinking 只能是 ${THINKING.join(", ")}`);
    head.push(`thinking: ${body.thinking}`);
  }
  if (typeof body.prompt !== "string") throw new HttpError(400, "prompt 必须是字符串");
  const dir = path.join(home, "presets");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, `${id}.md`), `---\n${head.join("\n")}\n---\n${body.prompt.trim()}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `预设已经存在：${id}`);
    throw e;
  }
}

/** 删 `presets/<ID>.md`。记忆库不动。 */
export function deletePreset(home: string, body: Record<string, unknown>): void {
  const id = presetId(body.id);
  try {
    unlinkSync(path.join(home, "presets", `${id}.md`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `没有这个预设：${id}`);
    throw e;
  }
}
