// 记忆页（设计稿 7.13）：看和改一个预设的记忆库。键按字节序，值能折起，写带版本号，冲突不覆盖。
import { html, Popover, DlgHead, SecHead, Pill, useState, useEffect, useRef, Fragment } from "./common.js";
import { memoryRead, memoryWrite } from "../api.js";
import { sortEntries, isLong, preview, editOf, newEdit, editDirty, editError, setOp, deleteOp, interpretWrite, afterConflict, overText, utf8Bytes } from "../lib/memory.js";

/** @typedef {import("../lib/memory.js").Entry} Entry */
/** @typedef {import("../lib/memory.js").Edit} Edit */
/** @typedef {{ warn: boolean, text: string }} Notice */

/** 元素第一次出现时拿焦点，之后重渲染不抢。 @param {HTMLElement | null} el */
function focusOnce(el) {
  if (el && !el.dataset["f"]) {
    el.dataset["f"] = "1";
    el.focus();
  }
}

/** @param {{ app: import("../app.js").App, onClose: () => void }} p */
export function MemoryDialog({ app, onClose }) {
  const ns = /** @type {string} */ (app.dialog?.props?.ns ?? "");
  const [entries, setEntries] = useState(/** @type {Entry[] | null} */ (null));
  const [loadErr, setLoadErr] = useState(/** @type {string | null} */ (null));
  const [edit, setEdit] = useState(/** @type {Edit | null} */ (null));
  const [asking, setAsking] = useState(/** @type {string | null} */ (null));
  const [open, setOpen] = useState(/** @type {Set<string>} */ (new Set()));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(/** @type {Notice | null} */ (null));
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /** 重读。先发的请求后回来时不算数。 */
  const load = async () => {
    const mine = ++seq.current;
    try {
      const got = await memoryRead(ns);
      if (alive.current && mine === seq.current) {
        setEntries(sortEntries(got));
        setLoadErr(null);
      }
    } catch (e) {
      if (alive.current && mine === seq.current) setLoadErr(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    load();
    // 兄弟进程随时在写：回到这个页面时重读。正在编辑的字不动，冲突留到保存时发现。
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ns]);

  const list = entries ?? [];
  const info = app.presets[ns];
  const noMemoryTool = info !== undefined && info.ok && !info.memory;

  /** 把写入的结果落到界面上。回 true 表示写成了。 @param {Edit | null} cur @param {any} reply @param {string} what */
  const settle = async (cur, reply, what) => {
    const o = interpretWrite(reply);
    if (o.kind === "ok") {
      setNotice(null);
      await load();
      return true;
    }
    if (o.kind === "conflict") {
      await load();
      if (cur) {
        setEdit(afterConflict(cur, o.current));
        setNotice({ warn: true, text: o.current ? "别处刚改过，已重读。你写的字还在，对照下面别处现在的值，再决定保存。" : "别处刚把这个键删了，已重读。你写的字还在，保存会把它重建。" });
      } else setNotice({ warn: true, text: o.current ? `别处刚改过，已重读，没有${what}。` : "这个键已经不在了，已重读。" });
      return false;
    }
    if (o.kind === "over") setNotice({ warn: true, text: overText(o.over, o.bytes) });
    else setNotice({ warn: true, text: "服务的回复读不懂" });
    return false;
  };

  /** @param {() => Promise<boolean>} fn */
  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      if (alive.current) setNotice({ warn: true, text: `没写进去：${e instanceof Error ? e.message : e}` });
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!edit) return false;
      const bad = editError(edit, list);
      if (bad) {
        setNotice({ warn: true, text: bad });
        return false;
      }
      const ok = await settle(edit, await memoryWrite([setOp(ns, edit)]), "保存");
      if (ok && alive.current) setEdit(null);
      return ok;
    });

  /** @param {Entry} entry */
  const remove = (entry) =>
    run(async () => {
      const ok = await settle(null, await memoryWrite([deleteOp(ns, entry)]), "删");
      if (alive.current) setAsking(null);
      return ok;
    });

  /** @param {string} key */
  const toggle = (key) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // 新键，或者正在改的键已被别处删掉（列表里没有它）：编辑器放在列表最上面，草稿不丢。
  const editing = edit !== null;
  const dirty = edit ? editDirty(edit) : false;
  const sub = list.length > 0 ? `${list.length} 个键` : entries ? "还没有键" : "";

  /** @param {Edit} e */
  const Editor = (e) => html`<li class="mem-row editing" key=${e.isNew ? "\u0000new" : e.key}>
    <div class="mem-h">
      ${e.isNew
        ? html`<input class="input mono mem-key" aria-label="键" placeholder="键" value=${e.key} ref=${focusOnce} onInput=${(/** @type {any} */ ev) => setEdit({ ...e, key: ev.currentTarget.value })} />`
        : html`<span class="mono mem-k">${e.key}</span>`}
      ${e.base !== null && html`<span class="mono dim mem-v">版本 ${e.base}</span>`}
    </div>
    <textarea class="input mono mem-ta" aria-label="值" rows="5" spellcheck="false" placeholder="值" value=${e.draft} ref=${e.isNew ? undefined : focusOnce} onInput=${(/** @type {any} */ ev) => setEdit({ ...e, draft: ev.currentTarget.value })}></textarea>
    <div class="dnote mono mem-bytes">${utf8Bytes(e.draft)} 字节</div>
    ${e.other &&
    ("gone" in e.other
      ? html`<div class="callout warn" role="status">别处把这个键删了。</div>`
      : html`<div class="callout warn" role="status"><div class="mem-other-h">别处现在的值</div><pre class="mem-pre">${e.other.value}</pre></div>`)}
    <div class="mem-acts">
      <${Pill} label="取消" disabled=${busy} onClick=${() => {
        setEdit(null);
        setNotice(null);
      }} />
      <${Pill} kind="accent" icon="check" label=${busy ? "写入中" : e.other ? "仍然保存" : "保存"} disabled=${busy || !dirty} onClick=${save} />
    </div>
  </li>`;

  return html`<${Popover} rect=${app.dialog?.rect} onClose=${onClose} label="记忆" width=${640} est=${640} class="memory">
    ${(/** @type {() => void} */ close) => html`<${Fragment}>
      <${DlgHead} icon="tau" title=${`${ns} 的记忆`} en="MEMORY" sub=${sub} onClose=${close} />
      <div class="dlg-body">
        <p class="dnote" style="color:var(--fg)">写入马上进库。运行中的进程用 memory_get 读到的是最新的；它提示词里挂的那份是开段时的快照，换段或者新开进程才更新。</p>
        ${noMemoryTool && html`<p class="dnote">这个预设没有 memory 工具，进程自己读写不了这个库。</p>`}
        ${notice && html`<div class=${`callout ${notice.warn ? "warn" : ""}`} role="alert">${notice.text}</div>`}
        ${loadErr !== null && html`<div class="callout warn" role="alert">读不到记忆：${loadErr}</div>`}
        <${SecHead} n="01" title="键值" en="ENTRIES" right=${html`<button type="button" class="link" disabled=${editing || busy} onClick=${() => {
          setEdit(newEdit());
          setNotice(null);
        }}>加一条</button>`} />
        ${entries === null && loadErr === null && html`<p class="dnote">读取中…</p>`}
        ${entries !== null && list.length === 0 && !edit && html`<p class="dnote">这个库里还没有键。</p>`}
        <ul class="mem-list" aria-label="记忆的键值">
          ${edit && (edit.isNew || !list.some((en) => en.key === edit.key)) && Editor(edit)}
          ${list.map((en) => {
            if (edit && !edit.isNew && edit.key === en.key) return Editor(edit);
            const long = isLong(en.value);
            const expanded = open.has(en.key);
            const ask = asking === en.key;
            return html`<li class=${`mem-row ${ask ? "asking" : ""}`} key=${en.key}>
              <div class="mem-h">
                <span class="mono mem-k">${en.key}</span>
                <span class="mono dim mem-v">版本 ${en.version}</span>
              </div>
              ${long && !expanded ? html`<div class="mem-fold">${preview(en.value)}<span class="dim"> …共 ${utf8Bytes(en.value)} 字节</span></div>` : html`<pre class="mem-pre">${en.value === "" ? "（空）" : en.value}</pre>`}
              ${ask
                ? html`<div class="mem-ask" role="alert"><span>删掉“${en.key}”？删了找不回。</span><${Pill} size="sm" label="取消" disabled=${busy} onClick=${() => setAsking(null)} /><${Pill} size="sm" kind="warn" icon="trash" label=${busy ? "删除中" : "删掉"} disabled=${busy} onClick=${() => remove(en)} /></div>`
                : html`<div class="mem-links">
                    ${long && html`<button type="button" class="link" aria-expanded=${expanded} onClick=${() => toggle(en.key)}>${expanded ? "折起" : "看全文"}</button>`}
                    <button type="button" class="link" disabled=${editing || busy} onClick=${() => {
                      setEdit(editOf(en));
                      setNotice(null);
                    }}>改</button>
                    <button type="button" class="link" disabled=${editing || busy} onClick=${() => {
                      setAsking(en.key);
                      setNotice(null);
                    }}>删</button>
                  </div>`}
            </li>`;
          })}
        </ul>
      </div>
      <div class="dlg-foot">
        <span class="cmdline"></span>
        <${Pill} label="关闭" onClick=${close} />
      </div>
    </${Fragment}>`}
  </${Popover}>`;
}
