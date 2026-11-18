// MCP 这一节（设计稿 7.12 的 MCP）：选项目、列配置里的服务器、列工具并生成定义、整个服务器装或更新或卸载、
// 看中转的状态。一个服务器要么装，要么不装，不能挑几个；工具清单只读。
// 起服务器要几秒，按钮上写“正在列”。纯逻辑在 lib/mcp.js，本文件只管画和发请求。
import { html, Pill, SecHead, Fragment, useState, useEffect, useRef, Icon } from "./common.js";
import { CheckStrip } from "./presetform.js";
import { formatBytes } from "../lib/format.js";
import { idleText, installable, sizeOf } from "../lib/mcp.js";
import * as api from "../api.js";

/** @typedef {import("../lib/mcp.js").GenTool} GenTool */
/** @typedef {{ name: string, command?: string, description?: string, timeout?: number, error?: string }} ServerEntry */
/** @typedef {{ file: string | null, servers: ServerEntry[] }} ServerList */
/** @typedef {{ instructions?: string, tools: GenTool[], gone: string[] }} Listed */

const STATUS = { none: ["line", "未装"], installed: ["acc", "已装"], differs: ["warn", "和现在的不同"] };

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {object} p
 * @param {import("../app.js").App} p.app
 * @param {{ name: string, usedBy: string[], mcp?: { server: string, tool: string } }[]} p.installed
 *   「已装的定义」：服务器卡上写已装几个，装完以后删服务器上已经没有的，卸载时拦被预设用到的。
 * @param {() => Promise<void>} p.onChanged 装完、删完以后让上面那一节和工具标签重读
 */
export function McpSection({ app, installed, onChanged }) {
  const projects = app.projects;
  /** 选中的项目（路径）。默认是现在聚焦的那个。 */
  const [project, setProject] = useState(/** @type {string} */ (projects.find((p) => p.key === app.project?.key)?.path ?? projects[0]?.path ?? ""));
  const [servers, setServers] = useState(/** @type {ServerList | null} */ (null));
  const [err, setErr] = useState("");
  const [listed, setListed] = useState(/** @type {({ server: string } & Listed) | null} */ (null));
  const [busy, setBusy] = useState(/** @type {string} */ ("")); // "" | "list:<服务器>" | "install" | "unload:<服务器>"
  const [note, setNote] = useState(""); // 装完、卸载完的一句话
  /** 等着确认卸载的服务器。 */
  const [askUnload, setAskUnload] = useState(/** @type {string} */ (""));
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [relayErr, setRelayErr] = useState("");
  const [openInstr, setOpenInstr] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const readStatus = async () => {
    try {
      const r = await api.mcpStatus();
      if (alive.current) {
        setStatus(r);
        setRelayErr("");
      }
    } catch (e) {
      if (alive.current) setRelayErr(msg(e));
    }
  };

  useEffect(() => void readStatus(), []);

  // 现在选中的项目。异步请求回来时拿它对一下：项目换过了，结果属于旧项目，丢掉，不能装进新项目的同名服务器。
  const current = useRef(project);
  current.current = project;
  /** @param {string} at 发请求时的项目 */
  const stale = (at) => !alive.current || current.current !== at;

  useEffect(() => {
    if (project === "") return;
    let live = true;
    setServers(null);
    setListed(null);
    setNote("");
    setAskUnload("");
    api.mcpServers(project).then(
      (r) => live && (setServers({ file: r.file ?? null, servers: r.servers ?? [] }), setErr("")),
      (e) => live && setErr(msg(e)),
    );
    return () => {
      live = false;
    };
  }, [project]);

  /** 列一个服务器的工具。起服务器要好几个请求的工夫，按钮上写“正在列”。 @param {string} server */
  const list = async (server) => {
    const at = project;
    setBusy(`list:${server}`);
    setNote("");
    try {
      const r = await api.mcpTools(at, server);
      if (stale(at)) {
        if (alive.current) setBusy("");
        return;
      }
      setListed({ server, instructions: r.instructions, tools: r.tools ?? [], gone: r.gone ?? [] });
      setErr("");
      setOpenInstr(false);
    } catch (e) {
      if (!stale(at)) {
        setListed(null);
        setErr(msg(e));
      }
    }
    await readStatus();
    if (alive.current) setBusy("");
  };

  /** @param {string} name */
  const usedBy = (name) => installed.find((d) => d.name === name)?.usedBy ?? [];

  /** 这个服务器已装的定义。 */
  const installedOf = (/** @type {string} */ server) => installed.filter((d) => d.mcp?.server === server);

  /**
   * 装这个服务器的全部能装的定义，装完把服务器上已经没有的定义一起删掉。
   * 被预设用到的留着，note 里写明是哪些预设。
   */
  const install = async () => {
    if (listed === null) return;
    const at = project;
    const server = listed.server;
    const gone = listed.gone;
    setBusy("install");
    setNote("");
    try {
      const r = await api.mcpInstall(at, server, installable(listed.tools).map((t) => t.tool));
      if (stale(at)) {
        if (alive.current) setBusy("");
        return;
      }
      const keep = gone.filter((n) => usedBy(n).length > 0);
      const drop = gone.filter((n) => usedBy(n).length === 0);
      /** @type {string[]} */
      const removed = [];
      /** @type {string[]} */
      const failed = [];
      for (const n of drop) {
        try {
          await api.removeTool(n);
          removed.push(n);
        } catch (e) {
          failed.push(`${n}：${msg(e)}`);
        }
      }
      /** @type {string[]} */
      const parts = [`装了 ${(r.installed ?? []).length} 个：${(r.installed ?? []).join("、") || "（没有可装的）"}`];
      if (removed.length > 0) parts.push(`删了服务器上已经没有的 ${removed.length} 个：${removed.join("、")}`);
      if (keep.length > 0) {
        const users = [...new Set(keep.flatMap((n) => usedBy(n)))];
        parts.push(`${keep.join("、")} 留着：预设 ${users.join("、")} 在用`);
      }
      if (failed.length > 0) parts.push(`没删掉 ${failed.join("；")}`);
      setNote(`${parts.join("。")}。`);
      await onChanged();
      setBusy("");
      // 重列一次：状态变成“已装”。
      await list(server);
    } catch (e) {
      if (alive.current) {
        setErr(msg(e));
        setBusy("");
      }
    }
  };

  /** 卸载一个服务器：行里确认过，逐个删它的定义。 @param {string} server @param {{ name: string }[]} mine */
  const unload = async (server, mine) => {
    setBusy(`unload:${server}`);
    setAskUnload("");
    setNote("");
    try {
      for (const d of mine) await api.removeTool(d.name);
      if (alive.current) setNote(`卸载了 ${server}：删了 ${mine.length} 个定义。`);
      await onChanged();
      if (listed !== null && listed.server === server && alive.current) await list(server);
    } catch (e) {
      if (alive.current) setErr(msg(e));
    }
    if (alive.current) setBusy("");
  };

  const size = listed === null ? null : sizeOf(listed.tools);
  // 能装的都有、都和现在的一样、服务器上也没有多余的旧定义：不用装，也可以说“已是最新”。
  const free = listed === null ? [] : installable(listed.tools);
  const latest = free.length > 0 && free.every((t) => t.status === "installed") && listed !== null && listed.gone.length === 0;
  const mine = listed === null ? [] : installedOf(listed.server);

  return html`<${Fragment}>
    <${SecHead} n="03" title="MCP" en="MCP SERVERS" right=${html`<span class="dnote" style="font-size:11px">${servers === null ? "" : `${servers.servers.length} 个服务器`}</span>`} />

    ${projects.length === 0
      ? html`<p class="dnote">先打开一个项目：MCP 的配置在每个项目的 <span class="mono">.pi/mcp.json</span> 里。</p>`
      : html`<div class="mcp-bar">
          <label class="mcp-pick">项目
            <select class="input mono" value=${project} disabled=${busy !== ""} title=${busy !== "" ? "正在列或正在装，完了再换项目" : undefined} onChange=${(/** @type {any} */ e) => setProject(e.currentTarget.value)}>
              ${projects.map((p) => html`<option key=${p.key} value=${p.path}>${p.name}</option>`)}
            </select>
          </label>
          <span class="dnote mono">${servers?.file ?? ""}</span>
        </div>`}

    ${project !== "" && servers !== null && servers.file === null && html`<div class="callout">这个项目里没有 MCP 配置文件：找过 <span class="mono">.pi/mcp.json</span> 和 <span class="mono">.mcp.json</span>。写一个再回来，第一次调用时中转会自动起服务器。</div>`}

    ${servers !== null && servers.servers.length > 0 &&
    html`<ul class="td-list" aria-label="MCP 服务器">
      ${servers.servers.map((s) => {
        const listing = busy === `list:${s.name}`;
        const active = listed?.server === s.name;
        const mine = installedOf(s.name);
        const users = [...new Set(mine.flatMap((d) => d.usedBy))];
        const asking = askUnload === s.name;
        return html`<li class=${`td-row ${s.error !== undefined ? "bad" : active || mine.length > 0 ? "installed" : ""}`} key=${s.name}>
          <div class="td-main">
            <div class="td-h">
              <b class="mono">${s.name}</b>
              ${mine.length > 0 && html`<span class="tag acc">已装 ${mine.length} 个</span>`}
              ${s.timeout !== undefined && html`<span class="tag line">${s.timeout} 秒</span>`}
              ${s.error !== undefined && html`<span class="tag warn">配置读不出</span>`}
            </div>
            ${s.command !== undefined && html`<div class="td-m mono" title=${s.command}>${s.command}</div>`}
            ${s.error !== undefined ? html`<p class="td-d bad">${s.error}</p>` : s.description !== undefined && html`<p class="td-d">${s.description}</p>`}
          </div>
          <div class="td-act">
            ${s.error !== undefined
              ? html`<span class="dnote">改好配置再列</span>`
              : html`<${Pill} size="sm" kind=${active ? "" : "accent"} label=${listing ? "正在列…" : "列出工具"} disabled=${busy !== ""} onClick=${() => list(s.name)} />`}
            ${mine.length > 0 &&
            (asking
              ? html`<div class="td-ask"><span>卸载：删掉这个服务器的 ${mine.length} 个定义，删了找不回。</span><span class="row2"><${Pill} size="sm" kind="warn" label="卸载" disabled=${busy !== ""} onClick=${() => unload(s.name, mine)} /><${Pill} size="sm" label="取消" onClick=${() => setAskUnload("")} /></span></div>`
              : users.length > 0
                ? html`<span class="dnote">预设 ${users.join("、")} 在用，不能卸载</span>`
                : html`<button type="button" class="link" disabled=${busy !== ""} onClick=${() => setAskUnload(s.name)}>卸载</button>`)}
          </div>
        </li>`;
      })}
    </ul>`}

    ${listed !== null &&
    html`<${Fragment}>
      ${listed.instructions !== undefined && listed.instructions !== "" &&
      html`<div class="mcp-instr">
        <button type="button" class="adv-h" aria-expanded=${openInstr} onClick=${() => setOpenInstr(!openInstr)}>
          <${Icon} name=${openInstr ? "up" : "down"} size=${13} sw=${2.8} /><span class="kicker">服务器的说明</span>
          <span class="sep"></span><span class="dim" style="font-size:12px">${listed.instructions.length} 字</span>
        </button>
        ${openInstr && html`<pre class="mcp-instr-t mono">${listed.instructions}</pre>`}
        <div class="mcp-instr-f">
          <button type="button" class="link" onClick=${() => copy(listed.instructions ?? "", setCopied)}>${copied ? "已复制" : "复制"}</button>
          <span class="dnote">工具描述里不带它：要模型知道，贴进预设的提示词。</span>
        </div>
      </div>`}

      <div class="td-h" style="margin:12px 0 6px"><b style="font-size:13px">${listed.server} 的工具</b><span class="tag line">${listed.tools.length} 个</span><span class="dnote" style="font-size:11px">只读：这个服务器一起装、一起卸，不挑单个。</span></div>
      <ul class="mcp-list" aria-label="工具清单">
        ${listed.tools.map((t) => {
          const skipped = t.skip !== undefined;
          const [tone, label] = STATUS[t.status];
          return html`<li class=${`mcp-row ${skipped ? "bad" : t.status === "installed" ? "installed" : ""}`} key=${t.name}>
            <div class="mcp-main">
              <div class="td-h">
                <b class="mono" style="font-size:13px">${t.name}</b>
                ${t.tool !== t.name && html`<span class="dnote mono">原名 ${t.tool}</span>`}
                <span class=${`tag ${tone}`}>${label}</span>
                <span class="dnote" style="font-size:11px">${formatBytes(t.bytes)}</span>
              </div>
              <p class="td-d">${t.description}</p>
              ${skipped && html`<p class="td-d bad">装不了：${t.skip}</p>`}
            </div>
          </li>`;
        })}
      </ul>

      ${size !== null &&
      html`<div class=${`mcp-size ${size.over ? "over" : ""}`}>
        <div class="mcp-size-bar"><span style=${`width:${Math.min(100, Math.round(size.ratio * 100))}%`}></span></div>
        <div class="mcp-size-t">
          <span class="mono">${formatBytes(size.bytes)} / ${formatBytes(size.limit)}</span>
          ${size.over
            ? html`<span class="mcp-warn">这个服务器一个预设放不下。</span>`
            : html`<span class="dnote">一个预设的工具定义加起来不能超过 ${formatBytes(size.limit)}。只算能装的。</span>`}
        </div>
      </div>`}

      <div class="mcp-foot">
        ${free.length === 0
          ? html`<span class="dnote">这个服务器没有能装的工具。</span>`
          : latest
            ? html`<span class="dnote" style="color:var(--acc)">已是最新。</span>`
            : html`<${Pill} kind="accent" label=${busy === "install" ? "正在装…" : mine.length > 0 ? "更新" : "安装"} disabled=${busy !== ""} onClick=${install} />`}
        <span class="dnote">写 <span class="mono">~/.tau/tools/${"<定义名>"}.json</span>。新出生的会话用新的，已有的会话在“改这个会话”里重读（换段时生效）。</span>
      </div>
    </${Fragment}>`}

    ${note !== "" && html`<p class="dnote" style="margin-top:8px;color:var(--acc)">${note}</p>`}
    ${err !== "" && html`<${CheckStrip} ok=${false} text=${err} label="mcp" />`}
    <div class="mcp-relay">
      <span class="kicker">中转</span>
      ${relayErr !== ""
        ? html`<span class="mono">${relayErr}</span>`
        : status === null
          ? html`<span class="dnote">正在看…</span>`
          : status.running !== true
            ? html`<span class="dnote">中转没在跑，第一次调用时自动起来。</span>`
            : html`<span class="dnote">在跑（PID ${status.pid}），${(status.instances ?? []).length} 个实例${(status.instances ?? []).length === 0 ? "" : "："}</span>
                ${(status.instances ?? []).map(
                  (/** @type {any} */ i, /** @type {number} */ n) =>
                    html`<span class="dnote mono" key=${n}>${i.process} · ${i.server} · 空闲 ${idleText(i.idleMs)}${i.busy > 0 ? ` · ${i.busy} 个在跑` : ""}${i.dead === true ? " · 已退出" : ""}</span>`,
                )}`}
      <button type="button" class="link" disabled=${busy !== ""} onClick=${() => void readStatus()}>刷新</button>
    </div>
  </${Fragment}>`;
}

/**
 * 复制一段文字。不是安全上下文时没有 `navigator.clipboard`，按失败处理。
 * @param {string} text
 * @param {(v: boolean) => void} done
 */
function copy(text, done) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(text).then(
    () => {
      done(true);
      setTimeout(() => done(false), 1500);
    },
    () => done(false),
  );
}
