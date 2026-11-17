// 只读的 git：固定的几条命令，不经 shell，带 --no-optional-locks，有超时。
import { execFile } from "node:child_process";
import path from "node:path";
import { HttpError } from "./util.ts";

export const DIFF_MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** 参数是 `git` 后面的全部参数，第一个永远是 `--no-optional-locks`。 */
export type GitRunner = (args: string[]) => Promise<{ code: number; stdout: string; overflow?: boolean }>;

export const runGit: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      // 超过缓冲上限：回调参数里是截好的输出，错误对象上没有。
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 0, stdout, overflow: true });
      if (typeof e.code === "number") return resolve({ code: e.code, stdout });
      if (e.killed) return reject(new HttpError(504, "git 超时"));
      reject(new HttpError(500, `运行 git 失败：${e.message}`));
    });
  });

export interface FileChange {
  path: string;
  status: string;
  add: number | null;
  del: number | null;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
  merged: boolean;
  add: number;
  del: number;
}

function norm(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function parseNumstat(text: string): Map<string, { add: number | null; del: number | null }> {
  const out = new Map<string, { add: number | null; del: number | null }>();
  const toks = text.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(toks[i] ?? "");
    if (!m) continue;
    let file = m[3] ?? "";
    // 改名：路径是空的，后面跟旧路径和新路径。
    if (file === "") {
      file = toks[i + 2] ?? "";
      i += 2;
    }
    out.set(file, { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
  }
  return out;
}

function sumNumstat(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const v of parseNumstat(text).values()) {
    add += v.add ?? 0;
    del += v.del ?? 0;
  }
  return { add, del };
}

function branchOfHeader(header: string): string | undefined {
  const h = header.slice(3);
  const none = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(h);
  if (none) return none[1];
  if (h.startsWith("HEAD (no branch)")) return undefined;
  const i = h.indexOf("...");
  return i >= 0 ? h.slice(0, i) : h.split(" ")[0];
}

export function createGit(run: GitRunner, allowed: () => Promise<string[]>) {
  async function git(dir: string, args: string[]) {
    return run(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", dir, ...args]);
  }

  async function checkDir(v: unknown): Promise<string> {
    if (typeof v !== "string" || v === "" || v.includes("\0")) throw new HttpError(400, "workdir 必须是字符串");
    const n = norm(v);
    if (!(await allowed()).some((a) => norm(a) === n)) throw new HttpError(403, "这个目录不是已知的项目目录");
    return path.resolve(v);
  }

  function checkFile(dir: string, v: unknown): string {
    if (typeof v !== "string" || v === "" || v.includes("\0") || v.startsWith("-")) throw new HttpError(400, "file 不合法");
    if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v)) throw new HttpError(400, "file 必须是相对路径");
    const full = path.resolve(dir, v);
    if (!full.toLowerCase().startsWith(dir.toLowerCase() + path.sep)) throw new HttpError(400, "file 不能出工作目录");
    return v;
  }

  async function status(dir: string) {
    const st = await git(dir, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
    if (st.code !== 0) return { repo: false };
    if (st.overflow) throw new HttpError(500, "git status 输出太大");
    const toks = st.stdout.split("\0").filter((t) => t !== "");
    let branch: string | undefined;
    if (toks[0]?.startsWith("## ")) branch = branchOfHeader(toks.shift() ?? "");
    const files: FileChange[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] ?? "";
      const code = t.slice(0, 2);
      files.push({ path: t.slice(3), status: code, add: null, del: null });
      if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i++;
    }
    const ns = await git(dir, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD"]);
    if (ns.code === 0 && !ns.overflow) {
      const stats = parseNumstat(ns.stdout);
      for (const f of files) {
        const s = stats.get(f.path);
        if (s) {
          f.add = s.add;
          f.del = s.del;
        }
      }
    }
    return { repo: true, ...(branch === undefined ? {} : { branch }), files };
  }

  async function diff(dir: string, file: unknown) {
    let out: { code: number; stdout: string; overflow?: boolean };
    if (file === undefined) {
      out = await git(dir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
    } else {
      // status 的路径相对仓库根，所以按文件取 diff 也在仓库根里跑。
      const top = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (top.code !== 0) return { text: "", truncated: false };
      const root = path.resolve(top.stdout.trim());
      const f = checkFile(root, file);
      const flags = ["--no-color", "--no-ext-diff", "--no-textconv"];
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "--", f])).stdout.trim() !== "";
      if (untracked) {
        out = await git(root, ["diff", "--no-index", ...flags, "--", "/dev/null", f]);
      } else {
        out = await git(root, ["diff", ...flags, "HEAD", "--", f]);
        // 还没有提交：HEAD 不存在，看暂存区。
        if (out.code !== 0 && out.code !== 1) out = await git(root, ["diff", "--cached", ...flags, "--", f]);
      }
    }
    const buf = Buffer.from(out.stdout);
    if (buf.length <= DIFF_MAX_BYTES && !out.overflow) return { text: out.stdout, truncated: false };
    return { text: buf.subarray(0, DIFF_MAX_BYTES).toString("utf8").replace(/�$/, ""), truncated: true };
  }

  async function log(dir: string) {
    const r = await git(dir, ["log", "-n", "30", "--no-color", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e"]);
    if (r.code !== 0) return { commits: [] };
    const commits = r.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => {
        const [hash = "", short = "", subject = "", author = "", ct = "0"] = s.split("\x1f");
        return { hash, short, subject, author, time: Number(ct) * 1000 };
      });
    return { commits };
  }

  async function branches(dir: string) {
    let main: string | null = null;
    for (const m of ["main", "master"]) {
      if ((await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${m}`])).code === 0) {
        main = m;
        break;
      }
    }
    const list = await git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
    if (list.code !== 0) return { main, branches: [] };
    const names = list.stdout.split("\n").map((s) => s.trim().replace(/^refs\/heads\//, "")).filter((s) => s !== "");
    const head = await git(dir, ["symbolic-ref", "-q", "HEAD"]);
    const current = head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, "") : null;
    const merged = new Set<string>();
    if (main !== null) {
      const r = await git(dir, ["for-each-ref", `--merged=refs/heads/${main}`, "--format=%(refname)", "refs/heads"]);
      for (const l of r.stdout.split("\n")) if (l.trim() !== "") merged.add(l.trim().replace(/^refs\/heads\//, ""));
    }
    const out: BranchInfo[] = [];
    for (const name of names) {
      let ahead = 0;
      let behind = 0;
      let add = 0;
      let del = 0;
      if (main !== null) {
        const c = await git(dir, ["rev-list", "--left-right", "--count", `refs/heads/${main}...refs/heads/${name}`]);
        const [l = "0", r = "0"] = c.stdout.trim().split(/\s+/);
        behind = Number(l);
        ahead = Number(r);
        const n = await git(dir, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", `refs/heads/${main}...refs/heads/${name}`]);
        ({ add, del } = sumNumstat(n.stdout));
      }
      out.push({ name, current: name === current, ahead, behind, merged: merged.has(name), add, del });
    }
    return { main, branches: out };
  }

  return async function handle(body: Record<string, unknown>): Promise<unknown> {
    const dir = await checkDir(body.workdir);
    switch (body.what) {
      case "status":
        return status(dir);
      case "diff":
        return diff(dir, body.file);
      case "log":
        return log(dir);
      case "branches":
        return branches(dir);
      default:
        throw new HttpError(400, "what 只能是 status、diff、log、branches");
    }
  };
}
