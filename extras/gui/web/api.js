// 页面和桥之间的请求。所有接口都是 POST；线协议的回复是一行一个 JSON。

/** 桥回的错误：带中文原因。 */
export class ApiError extends Error {}

/**
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<any>}
 */
export async function post(path, body = {}) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError("连不上桥");
  }
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    // 不是 JSON，当没有内容。
  }
  if (!res.ok) throw new ApiError(json && typeof json.error === "string" ? json.error : `请求失败（${res.status}）`);
  return json ?? {};
}

/**
 * 发一条线协议请求，逐行读回复。`onReply` 返回 true 就断开（例如拿到回执）。
 * 返回时连接已经结束。`signal` 中止也算结束，不抛错。
 * @param {Record<string, unknown>} request
 * @param {(reply: any) => boolean | void} onReply
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function tauStream(request, onReply, signal) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener("abort", stop);
  try {
    let res;
    try {
      res = await fetch("/api/tau", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) return;
      throw new ApiError("连不上桥");
    }
    if (!res.ok || !res.body) {
      let msg = `请求失败（${res.status}）`;
      try {
        const j = await res.json();
        if (j && typeof j.error === "string") msg = j.error;
      } catch {
        // 用默认原因。
      }
      throw new ApiError(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (ctl.signal.aborted) return;
        throw new ApiError("连接断了");
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (onReply(reply) === true) {
          ctl.abort();
          return;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * 发一条请求，收齐回复（连接由服务关闭）。
 * @param {Record<string, unknown>} request
 * @returns {Promise<any[]>}
 */
export async function tauAll(request) {
  /** @type {any[]} */
  const out = [];
  await tauStream(request, (r) => {
    out.push(r);
  });
  const err = out.find((r) => r.type === "error");
  if (err) throw new ApiError(err.message);
  return out;
}

/**
 * 发一条命令（start、send、fork、stop 等），拿到回执就断开。回执是 { type: "receipt", process }。
 * stop、remove、prune 等的回执也一样。出错抛错。
 * @param {Record<string, unknown>} request
 * @returns {Promise<{ process?: string }>}
 */
export async function tauCommand(request) {
  /** @type {any} */
  let receipt = null;
  /** @type {any} */
  let error = null;
  await tauStream(request, (r) => {
    if (r.type === "receipt") {
      receipt = r;
      return true;
    }
    if (r.type === "error") {
      error = r;
      return true;
    }
    if (r.type === "swept") {
      receipt = r;
      return true;
    }
    return false;
  });
  if (error) throw new ApiError(error.message);
  if (!receipt) throw new ApiError("服务没有回执");
  return receipt;
}

export const presets = () => post("/api/presets", {}).then((r) => /** @type {any[]} */ (r.presets ?? []));
export const createPreset = (/** @type {any} */ p) => post("/api/presets/create", p);
export const getState = () => post("/api/state", {}).then((r) => r.state ?? {});
export const setState = (/** @type {Record<string, unknown>} */ set) => post("/api/state", { set }).then((r) => r.state ?? {});
export const git = (/** @type {string} */ workdir, /** @type {string} */ what, /** @type {string} [file] */ file) => post("/api/git", { workdir, what, ...(file !== undefined ? { file } : {}) });
export const bg = (/** @type {string[]} */ processes) => post("/api/bg", { processes }).then((r) => r.logs ?? []);
export const pickFolder = () => post("/api/pick-folder", {}).then((r) => /** @type {string | null} */ (r.path ?? null));

/** @type {Map<string, Promise<string | null>>} */
const blobs = new Map();
/**
 * 一张图片的 data URL。同一张只取一次。
 * @param {string} hash
 * @returns {Promise<string | null>}
 */
export function blobUrl(hash) {
  let p = blobs.get(hash);
  if (!p) {
    p = tauAll({ op: "blob", hash })
      .then((rs) => {
        const b = rs.find((r) => r.type === "blob");
        return b ? `data:${b.mimeType};base64,${b.data}` : null;
      })
      .catch(() => null);
    blobs.set(hash, p);
  }
  return p;
}
