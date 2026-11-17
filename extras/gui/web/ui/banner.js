// 旧代码横幅：服务或桥在跑旧代码时，贴在右上角，不挡操作。点按钮重启；有进程在跑时先确认。
import { html, useEffect, useRef, useState } from "./common.js";
import * as api from "../api.js";
import { staleOf, confirmText } from "../lib/service.js";

const POLL_MS = 30000;
const WAIT_MS = 45000;

/** @param {{ app: import("../app.js").App }} p */
export function ServiceBanner({ app }) {
  const [st, setSt] = useState(/** @type {any} */ (null));
  const [ask, setAsk] = useState(/** @type {number | null} */ (null));
  /** 重启已经发出，等新的状态。 */
  const [waiting, setWaiting] = useState(/** @type {"service" | "bridge" | null} */ (null));
  const alive = useRef(true);

  const poll = () =>
    api.serviceStatus().then(
      (s) => {
        if (alive.current) setSt(s);
        return s;
      },
      () => null,
    );

  useEffect(() => {
    alive.current = true;
    poll();
    const t = setInterval(poll, POLL_MS);
    const f = () => poll();
    window.addEventListener("focus", f);
    return () => {
      alive.current = false;
      clearInterval(t);
      window.removeEventListener("focus", f);
    };
  }, []);
  // 连上了（包括重连）就重新看一次。
  useEffect(() => {
    if (app.status === "online") poll();
  }, [app.status]);
  // 重启之后每隔几秒看一次，旧代码的标记没了就停；等太久也停。
  useEffect(() => {
    if (waiting === null) return;
    const t0 = Date.now();
    const t = setInterval(() => {
      poll().then((s) => {
        const k = staleOf(s);
        if (s && !k[waiting] && Date.now() - t0 > 2000) setWaiting(null);
        else if (Date.now() - t0 > WAIT_MS) setWaiting(null);
      });
    }, 2500);
    return () => clearInterval(t);
  }, [waiting]);

  const stale = staleOf(st);
  if (!stale.service && !stale.bridge && waiting === null) return null;

  /** @param {"service" | "bridge"} which @param {boolean} force */
  const go = async (which, force) => {
    setAsk(null);
    try {
      await api.restartService({ [which]: true, ...(force ? { force: true } : {}) });
      setWaiting(which);
    } catch (e) {
      const err = /** @type {import("../api.js").ApiError} */ (e);
      if (err.status === 409) {
        const fresh = await poll();
        setAsk(fresh && typeof fresh.running === "number" && fresh.running > 0 ? fresh.running : app.entries.filter((x) => x.status === "running").length || 1);
      } else app.toast(err instanceof Error ? err.message : String(err));
    }
  };
  const restartService = async () => {
    const fresh = await poll();
    const n = fresh && typeof fresh.running === "number" ? fresh.running : app.entries.filter((x) => x.status === "running").length;
    if (n > 0) setAsk(n);
    else go("service", false);
  };

  if (waiting !== null) return html`<div class="svc" role="status"><span>${waiting === "service" ? "正在重启服务…" : "正在重启桥，页面会自己重连…"}</span></div>`;
  if (ask !== null) {
    return html`<div class="svc ask" role="alertdialog" aria-label="确认重启服务">
      <span>${confirmText(ask)}</span>
      <button type="button" class="link" onClick=${() => go("service", true)}>确认重启</button>
      <button type="button" class="link" onClick=${() => setAsk(null)}>取消</button>
    </div>`;
  }
  return html`<div class="svc" role="status">
    ${stale.service && html`<span>服务在跑旧代码</span><button type="button" class="link" onClick=${restartService}>重启服务</button>`}
    ${stale.bridge && html`<span>桥在跑旧代码</span><button type="button" class="link" onClick=${() => go("bridge", false)}>重启桥</button>`}
  </div>`;
}

/** 和服务断开时放在断开提示里的按钮。 @param {{ app: import("../app.js").App }} p */
export function StartServiceButton({ app }) {
  const [busy, setBusy] = useState(false);
  const go = () => {
    setBusy(true);
    api.restartService({ service: true }).then(
      () => app.toast("正在拉起服务…"),
      (e) => app.toast(`拉不起服务：${e instanceof Error ? e.message : e}`),
    ).finally(() => setTimeout(() => setBusy(false), 5000));
  };
  return html`<button type="button" class="link" disabled=${busy} onClick=${go}>拉起服务</button>`;
}
