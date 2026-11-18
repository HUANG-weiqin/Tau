// 改动页点文件弹出的 diff 窗（设计稿 7.14）。
// 只显示 git 的原样输出，不自己算 diff。行号从 hunk 头里读。
// 状态和 diff 自己轮询，窗开着时每 10 秒刷新。
import { html, Popover, DlgHead, Pill, useState, useEffect, useRef, Fragment } from "./common.js";
import * as api from "../api.js";
import { usePoll, POLL_MS, Delta, Waiting, buildTree, flatten, statusLetter } from "./inspector.js";

const MAX_DIFF_LINES = 3000;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** 文件头里已经在标题上写过的行：只在第一个 hunk 之前隐藏。 */
const FILE_HEAD = /^(diff |index |--- |\+\+\+ )/;

/**
 * 把 git diff 的原样输出拆成行：meta（模式、改名这类说明）、hunk 头、增删和上下文。
 * 上下文行两边行号都加一，`-` 只加旧的，`+` 只加新的。
 * @param {string[]} lines
 */
function parseDiff(lines) {
  /** @type {{ kind: "meta" | "hunk" | "ctx" | "add" | "del" | "note", old: number | null, now: number | null, text: string }[]} */
  const rows = [];
  let inHunk = false;
  let sections = 0;
  let oldN = 0;
  let newN = 0;
  let max = 0;
  for (const l of lines) {
    if (l.startsWith("diff ")) {
      inHunk = false;
      // 第一个文件的头在标题上写过，不显示；之后再有文件头，就明着列出来，不把几个文件悄悄并成一个。
      if (++sections > 1) rows.push({ kind: "meta", old: null, now: null, text: l });
      continue;
    }
    const h = HUNK.exec(l);
    if (h) {
      inHunk = true;
      oldN = Number(h[1]);
      newN = Number(h[2]);
      rows.push({ kind: "hunk", old: null, now: null, text: l });
      continue;
    }
    if (l.startsWith("@@")) {
      inHunk = true;
      rows.push({ kind: "hunk", old: null, now: null, text: l });
      continue;
    }
    if (!inHunk) {
      if (sections > 1 || !FILE_HEAD.test(l)) rows.push({ kind: "meta", old: null, now: null, text: l });
      continue;
    }
    if (l.startsWith("\\")) rows.push({ kind: "note", old: null, now: null, text: l });
    else if (l.startsWith("+")) rows.push({ kind: "add", old: null, now: newN++, text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ kind: "del", old: oldN++, now: null, text: l.slice(1) });
    else rows.push({ kind: "ctx", old: oldN++, now: newN++, text: l.slice(1) });
    max = Math.max(max, oldN, newN);
  }
  return { rows, digits: String(max).length };
}

/** git diff 的原样输出，按行着色，带新旧两列行号。 */
function DiffText({ text, truncated }) {
  const all = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const { rows, digits } = parseDiff(all.slice(0, MAX_DIFF_LINES));
  const cells = rows.map((r, i) => {
    if (r.kind === "meta") return html`<div key=${i} class="df meta"><span class="df-t">${r.text}</span></div>`;
    if (r.kind === "hunk") return html`<div key=${i} class="df hunk"><span class="df-t">${r.text}</span></div>`;
    if (r.kind === "note") return html`<div key=${i} class="df note"><span class="df-g" aria-hidden="true"><span class="df-n"></span><span class="df-n"></span><span class="df-s"></span></span><span class="df-t">${r.text}</span></div>`;
    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
    return html`<div key=${i} class=${`df ${r.kind}`}><span class="df-g" aria-hidden="true"><span class="df-n">${r.old ?? ""}</span><span class="df-n">${r.now ?? ""}</span><span class="df-s">${sign}</span></span><span class="df-t">${r.text}</span></div>`;
  });
  return html`<div class="diff-lines" style=${`--gw:${digits}ch`}>${cells}</div>
    ${(all.length > MAX_DIFF_LINES || truncated) && html`<p class="inote diff-note">${truncated ? "diff 太长，只显示了前 256 KB。" : `diff 太长，只显示前 ${MAX_DIFF_LINES} 行。`}</p>`}`;
}

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function DiffDialog({ app, onClose }) {
  const workdir = /** @type {string} */ (app.dialog?.props?.workdir ?? "");
  const [cur, setCur] = useState(/** @type {string} */ (app.dialog?.props?.file ?? ""));
  const status = usePoll(`dst|${workdir}`, () => api.git(workdir, "status"), POLL_MS);
  const st = status.value;
  // 自己的轮询回来之前，先用打开时带来的文件列表，免得底栏闪一下。
  /** @type {{ path: string, status: string, add: number | null, del: number | null }[]} */
  const files = st ? (st.repo ? st.files : []) : (app.dialog?.props?.files ?? []);
  const sig = files.map((f) => `${f.path}:${f.status}:${f.add}:${f.del}`).join("|");
  const d = usePoll(`dd|${workdir}|${cur}`, () => api.git(workdir, "diff", cur), POLL_MS, sig);
  const v = d.value;

  const order = flatten(buildTree(files), 0)
    .filter((r) => r.kind === "file")
    .map((r) => /** @type {string} */ (r.file.path));
  const idx = order.indexOf(cur);
  const info = files.find((f) => f.path === cur) ?? null;
  const step = (/** @type {number} */ by) => {
    const next = order[idx + by];
    if (idx >= 0 && next !== undefined) setCur(next);
  };

  // 快捷键里要用最新的 step，存进 ref，监听只挂一次。
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      stepRef.current(e.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 换文件时回到左上角。
  const box = useRef(/** @type {HTMLElement | null} */ (null));
  useEffect(() => {
    box.current?.scrollTo(0, 0);
  }, [cur]);

  const slash = cur.lastIndexOf("/");
  const name = slash < 0 ? cur : cur.slice(slash + 1);
  const dir = slash < 0 ? "" : cur.slice(0, slash + 1);
  const [letter, label] = info ? statusLetter(info.status) : ["", ""];
  const sub = html`<span class="diff-sub">
    ${dir !== "" && html`<span class="mono">${dir}</span>`}
    ${info && html`<span class=${`tmark ${letter === "A" ? "add" : letter === "D" ? "del" : ""}`} aria-label=${label}>${letter}</span><${Delta} add=${info.add} del=${info.del} />`}
  </span>`;

  return html`<${Popover} rect=${null} onClose=${onClose} label="改动" width=${Math.min(1240, window.innerWidth - 120)} class="diffdlg">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="branch" title=${name} en="DIFF" sub=${sub} onClose=${close} />
      <div class="diff-wrap">
        <div class="diff-box" ref=${box} tabindex="0" autofocus aria-label=${`${cur} 的 diff`}>
          ${v ? (v.text === "" ? html`<p class="inote diff-note">没有文本改动。</p>` : html`<${DiffText} text=${v.text} truncated=${v.truncated === true} />`) : html`<${Waiting} st=${d} what="读不到 diff" />`}
        </div>
      </div>
      <div class="dlg-foot">
        <span class="cmdline"></span>
        <span class="mono dim diff-count">${idx >= 0 ? `${idx + 1} / ${order.length}` : "—"}</span>
        <${Pill} icon="up" label="上一个" disabled=${idx <= 0} onClick=${() => step(-1)} />
        <${Pill} icon="down" label="下一个" disabled=${idx < 0 || idx >= order.length - 1} onClick=${() => step(1)} />
        <${Pill} label="关闭" onClick=${close} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
