// 填写和清除 pi 的 auth.json 里的 api_key（D69）。只动这一家的 `api_key` 条目，其它条目原样带回。
// 读、改、写之间没有 await；先写临时文件再改名。key 的值不进返回值、错误文字。不导入 src/。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpError, isObject } from "./util.ts";

const KEY_MAX_BYTES = 4096;
const OAUTH = "OAuth 登录的，tau 不改";
const NOT_API_KEY = "这一家的条目不是 api_key，tau 不改";

/** 返回存进去的值（trim 后）。错误文字里没有 key 的任何字符。 */
function checkKey(key: unknown): string {
  if (typeof key !== "string") throw new HttpError(400, "key 必须是字符串");
  const k = key.trim();
  if (k === "") throw new HttpError(400, "key 不能是空的");
  if (/[\u0000-\u001f\u007f]/.test(k)) throw new HttpError(400, "key 里不能有控制字符或换行");
  if (Buffer.byteLength(k) > KEY_MAX_BYTES) throw new HttpError(400, `key 超过 ${KEY_MAX_BYTES} 字节`);
  if (k.startsWith("!") || k.includes("$")) throw new HttpError(400, "key 不能以 ! 开头或含 $：tau 不执行命令也不展开变量");
  return k;
}

/** 读整个文件。文件不存在是 `{}`；读不出、不是合法 JSON、顶层不是对象都拒绝，原因不带文件内容。 */
function readAll(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new HttpError(409, "读不了 auth.json，没有改它");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(409, "auth.json 不是合法的 JSON，没有改它。pi 正在写这个文件时也会这样，稍后再试");
  }
  if (!isObject(raw)) throw new HttpError(409, "auth.json 的顶层不是 JSON 对象，没有改它");
  return raw;
}

function writeAll(file: string, obj: Record<string, unknown>): void {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw new HttpError(500, "写不了 auth.json");
  }
}

/** 这一家已有的条目：必须没有，或者是 api_key。 */
function existing(obj: Record<string, unknown>, provider: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(obj, provider)) return undefined;
  const c = obj[provider];
  if (isObject(c) && c.type === "api_key") return c;
  throw new HttpError(409, isObject(c) && c.type === "oauth" ? OAUTH : NOT_API_KEY);
}

export function setKey(file: string, provider: string, key: unknown): void {
  const k = checkKey(key);
  const obj = readAll(file);
  const have = existing(obj, provider);
  obj[provider] = have === undefined ? { type: "api_key", key: k } : { ...have, key: k };
  writeAll(file, obj);
}

export function clearKey(file: string, provider: string): void {
  const obj = readAll(file);
  if (existing(obj, provider) === undefined) return;
  delete obj[provider];
  writeAll(file, obj);
}
