// 工具定义弹窗（设计稿 7.12）：01 已装的定义、02 工具库、03 MCP。
// 删和覆盖都在行里二次确认。工具定义的内容在会话出生时读进快照：新出生的会话用新的，已有的会话在“改这个会话”里重读。
// 01 里 MCP 生成的定义不逐个列：一个服务器一行，默认折着，删是整个服务器一起删。
import { html, Popover, DlgHead, SecHead, Pill, useState, useEffect, useRef, Fragment } from "./common.js";
import { CheckStrip } from "./presetform.js";
import { McpSection } from "./mcp.js";
import { groupByServer } from "../lib/mcp.js";
import * as api from "../api.js";

/** @typedef {{ name: string, description?: string, params?: string[], timeout?: number, output?: string, command?: string, error?: string, usedBy: string[], mcp?: { server: string, tool: string } }} Installed */
/** @typedef {{ name: string, description: string, params: string[], timeout: number, output: string, command: string, status: "none" | "installed" | "differs" }} Library */

const STATUS = { none: ["line", "未安装"], installed: ["acc", "已安装"], differs: ["warn", "和库里不同"] };

/** @param {unknown} e */
const msg = (e) => (e instanceof Error ? e.message : String(e));

/** 一行的头：名字和几个小标记。 @param {{ name: string, children?: any }} p */
function Head({ name, children }) {
  return html`<div class="td-h"><b class="mono">${name}</b>${children}</div>`;
}

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function ToolsDialog({ app, onClose }) {
  const [data, setData] = useState(/** @type {{ installed: Installed[], library: Library[] } | null} */ (null));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  /** 等着确认的动作：删一个定义、删一个 MCP 服务器、覆盖库里的定义。 */
  const [ask, setAsk] = useState(/** @type {{ kind: "remove" | "replace", name: string } | { kind: "removeServer", server: string, names: string[] } | null} */ (null));
  /** 点开看了工具名的 MCP 服务器。默认折着。 */
  const [openSrv, setOpenSrv] = useState(/** @type {string[]} */ ([]));
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = async () => {
    try {
      const r = await api.tools();
      if (alive.current) {
        setData({ installed: r.installed ?? [], library: r.library ?? [] });
        setErr("");
      }
    } catch (e) {
      if (alive.current) setErr(msg(e));
    }
  };
  useEffect(() => void load(), []);

  /** 装完、删完以后：重读这一页，再让全页的工具标签重读 `/api/tools`。 */
  const refresh = async () => {
    await load();
    await app.reloadDefs();
  };

  /** @param {() => Promise<unknown>} f */
  const act = async (f) => {
    setBusy(true);
    setAsk(null);
    try {
      await f();
      setErr("");
    } catch (e) {
      if (alive.current) setErr(msg(e));
    }
    await refresh();
    if (alive.current) setBusy(false);
  };

  const installed = data?.installed ?? [];
  const library = data?.library ?? [];
  // MCP 生成的定义按服务器折成一行；别的（库里的、手写的）一行一个。
  const { groups: mcpGroups, others } = groupByServer(installed);
  /** 一个服务器算一个，不数它的定义。 */
  const rows = mcpGroups.length + others.length;
  /** 一个定义一行的动作：删除的确认。 @param {Installed} t */
  const defAct = (t) =>
    html`${ask !== null && ask.kind === "remove" && ask.name === t.name
      ? html`<div class="td-ask"><span>删了找不回。</span><span class="row2"><${Pill} size="sm" kind="warn" label="删除" disabled=${busy} onClick=${() => act(() => api.removeTool(t.name))} /><${Pill} size="sm" label="取消" onClick=${() => setAsk(null)} /></span></div>`
      : t.usedBy.length > 0
        ? html`<span class="dnote">有预设在用，不能删</span>`
        : html`<button type="button" class="link" disabled=${busy} onClick=${() => setAsk({ kind: "remove", name: t.name })}>删除</button>`}`;
  /**
   * 一个 MCP 服务器一行：名字、MCP 标签、几个工具、几个预设在用（用到它的预设取并集），点开看工具名。
   * 删是整个服务器一起删；有任何一个定义被预设用到就不给删。
   * @param {{ server: string, defs: Installed[] }} g
   */
  const serverRow = (g) => {
    const used = [...new Set(g.defs.flatMap((d) => d.usedBy))];
    const open = openSrv.includes(g.server);
    const names = g.defs.map((d) => d.name);
    const asking = ask !== null && ask.kind === "removeServer" && ask.server === g.server;
    return html`<li class=${`td-row ${used.length > 0 ? "used" : ""}`} key=${`mcp:${g.server}`}>
      <div class="td-main">
        <${Head} name=${g.server}>
          <span class="tag acc">MCP</span>
          <span class="tag line">${g.defs.length} 个工具</span>
          ${used.length > 0 && html`<span class="tag acc" title=${`预设：${used.join("、")}`}>${used.length} 个预设在用</span>`}
          <button type="button" class="link" aria-expanded=${open} onClick=${() => setOpenSrv(open ? openSrv.filter((x) => x !== g.server) : [...openSrv, g.server])}>${open ? "收起工具名" : "工具名"}</button>
        </${Head}>
        ${open && html`<div class="td-m mono">${names.join("、")}</div>`}
        ${used.length > 0 && html`<div class="td-m">用到它的预设：${used.join("、")}</div>`}
      </div>
      <div class="td-act">
        ${asking
          ? html`<div class="td-ask"><span>删掉这个服务器的 ${g.defs.length} 个定义，删了找不回。</span><span class="row2"><${Pill} size="sm" kind="warn" label="删除" disabled=${busy} onClick=${() => act(async () => { for (const n of names) await api.removeTool(n); })} /><${Pill} size="sm" label="取消" onClick=${() => setAsk(null)} /></span></div>`
          : used.length > 0
            ? html`<span class="dnote">有预设在用，不能删</span>`
            : html`<button type="button" class="link" disabled=${busy} onClick=${() => setAsk({ kind: "removeServer", server: g.server, names })}>删除</button>`}
      </div>
    </li>`;
  };
  /** 一个不是 MCP 的定义一行。 @param {Installed} t */
  const defRow = (t) => html`<li class=${`td-row ${t.error !== undefined ? "bad" : t.usedBy.length > 0 ? "used" : ""}`} key=${t.name}>
      <div class="td-main">
        <${Head} name=${t.name}>
          ${t.error !== undefined && html`<span class="tag warn">读不出</span>`}
          ${t.timeout !== undefined && html`<span class="tag line">${t.timeout} 秒</span>`}
          ${t.output !== undefined && html`<span class="tag line">${t.output}</span>`}
          ${t.usedBy.length > 0 && html`<span class="tag acc" title=${`预设：${t.usedBy.join("、")}`}>${t.usedBy.length} 个预设在用</span>`}
        </${Head}>
        <p class=${`td-d ${t.error !== undefined ? "bad" : ""}`}>${t.error ?? (t.description === "" ? "（没有说明）" : t.description)}</p>
        ${t.params !== undefined && t.params.length > 0 && html`<div class="td-m mono">参数：${t.params.join("、")}</div>`}
        ${t.command !== undefined && html`<div class="td-m mono" title=${t.command}>${t.command.length > 140 ? `${t.command.slice(0, 140)}…` : t.command}</div>`}
        ${t.usedBy.length > 0 && html`<div class="td-m">用到它的预设：${t.usedBy.join("、")}</div>`}
      </div>
      <div class="td-act">${defAct(t)}</div>
    </li>`;

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="工具定义" width=${720} est=${720} class="tools">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="term" title="工具定义" en="TOOLS" sub="~/.tau/tools" onClose=${close} />
      <div class="dlg-body">
        <${SecHead} n="01" title="已装的定义" en="INSTALLED" right=${html`<span class="dnote" style="font-size:11px">${data === null ? "" : `${rows} 个`}</span>`} />
        ${data === null
          ? html`<p class="dnote">${err !== "" ? "" : "正在读…"}</p>`
          : installed.length === 0
            ? html`<p class="dnote">tools 目录里还没有工具定义。从下面的工具库装。</p>`
            : html`<ul class="td-list" aria-label="已装的工具定义">
                ${mcpGroups.map(serverRow)}
                ${others.map(defRow)}
              </ul>`}

        <${SecHead} n="02" title="工具库" en="LIBRARY" right=${html`<span class="dnote" style="font-size:11px">extras/tools</span>`} />
        ${library.length === 0
          ? html`<p class="dnote">${data === null ? "" : "工具库是空的。"}</p>`
          : html`<ul class="td-list" aria-label="工具库">
              ${library.map((t) => {
                const [tone, label] = STATUS[t.status];
                return html`<li class=${`td-row ${t.status}`} key=${t.name}>
                  <div class="td-main">
                    <${Head} name=${t.name}>
                      <span class=${`tag ${tone}`}>${label}</span>
                      <span class="tag line">${t.timeout} 秒</span>
                    </${Head}>
                    <p class="td-d">${t.description}</p>
                    <div class="td-m mono">参数：${t.params.join("、")}</div>
                  </div>
                  <div class="td-act">
                    ${t.status === "none"
                      ? html`<${Pill} size="sm" kind="accent" label="安装" disabled=${busy} onClick=${() => act(() => api.installTool(t.name))} />`
                      : t.status === "differs"
                        ? ask?.kind === "replace" && ask.name === t.name
                          ? html`<div class="td-ask"><span>覆盖 ${t.name}.json，里面改过的内容会丢。</span><span class="row2"><${Pill} size="sm" kind="warn" label="覆盖" disabled=${busy} onClick=${() => act(() => api.installTool(t.name, true))} /><${Pill} size="sm" label="取消" onClick=${() => setAsk(null)} /></span></div>`
                          : html`<${Pill} size="sm" label="更新" disabled=${busy} onClick=${() => setAsk({ kind: "replace", name: t.name })} />`
                        : html`<span class="dnote">已是库里的样子</span>`}
                  </div>
                </li>`;
              })}
            </ul>`}
        <${McpSection} app=${app} installed=${installed} onChanged=${refresh} />
        ${err !== "" && html`<${CheckStrip} ok=${false} text=${err} label="tools" />`}
        <p class="dnote">工具定义的内容在会话出生时读进快照：装了、更新了，新出生的会话用新的；已有的会话要用，在“改这个会话”里勾上，或者点工具区的“重读工具定义”，换段时生效。库里的工具和 MCP 的定义都装在 <span class="mono">~/.tau/tools/</span>；仓库挪了位置，点“更新”或“列出工具”重装。要用哪个，在预设的工具里勾选。</p>
      </div>
      <div class="dlg-foot">
        <span class="cmdline">${data === null ? "" : `${rows} 个已装，工具库 ${library.length} 个`}</span>
        <${Pill} kind="accent" icon="check" label="完成" onClick=${close} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
