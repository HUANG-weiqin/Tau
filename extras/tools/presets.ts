// 预设工具共用的检查和路径小件（kb-extras 的“工具库”）。不导入 src/。
import { homedir } from "node:os";
import path from "node:path";
import { Fail } from "./common.ts";

const PRESET_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 预设 ID 校验（与内核 `checkPresetId` 一致：不许路径分隔符、冒号和 `..`；上限 64 字）。 */
export function isPresetId(id: string): boolean {
  return PRESET_ID.test(id) && !/^\.+$/.test(id) && !id.endsWith(".") && !id.includes("..");
}

export function checkPresetId(raw: unknown): string {
  if (typeof raw !== "string" || !isPresetId(raw)) {
    throw new Fail(`预设 ID 只许 1 到 64 个字母、数字、点、下划线和连字符；不能全是点，不能以点结尾，不能有连续的点。收到“${String(raw)}”。例如 code-review。`);
  }
  return raw;
}

export function presetsDir(home: string = path.join(homedir(), ".tau")): string {
  return path.join(home, "presets");
}

/** 只认盘符路径和 UNC 路径，和内核读预设的规则一致。 */
export function isAbsoluteWinPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** 路径写成正斜杠。 */
export const forward = (p: string): string => p.replace(/\x5c/g, "/");

/** 模型常把预设写成“reviewer.md”或预设目录下的完整路径：取出预设 ID。别的目录下的路径原样留着，由 `checkPresetId` 拒绝。 */
export function presetIdOf(raw: string, dir: string = presetsDir()): string {
  let s = raw.trim();
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\x5c"));
  if (i >= 0 && path.resolve(s.slice(0, i)).toLowerCase() === path.resolve(dir).toLowerCase()) s = s.slice(i + 1);
  return s.replace(/\.md$/i, "");
}

/**
 * 路径的几种常见写法换成预设文件认的写法（同 D91）：/d/x 换成 D:/x；~ 换成家目录；
 * `base` 不为 null 时，相对路径（含 "."）按它解析。认不出的原样返回，由调用方的检查拒绝。
 */
export function winPathOf(raw: string, base: string | null, home: string): string {
  const s = raw.trim();
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
  if (m) return `${m[1]!.toUpperCase()}:${m[2] ?? "/"}`;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\x5c")) return forward(path.join(home, s.slice(1)));
  if (base !== null && s !== "" && !/^[/\x5c~]/.test(s) && !isAbsoluteWinPath(s)) return forward(path.resolve(base, s));
  return s;
}
