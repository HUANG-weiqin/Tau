// 预设工具共用的检查和路径小件（kb-extras 的“工具库”）。不导入 src/。
import { homedir } from "node:os";
import path from "node:path";
import { Fail } from "./common.ts";

const PRESET_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 预设 ID 校验（与 GUI 桥、内核规则兼容，上限 64 字）。 */
export function isPresetId(id: string): boolean {
  return PRESET_ID.test(id) && !/^\.+$/.test(id) && !id.endsWith(".");
}

export function checkPresetId(raw: unknown): string {
  if (typeof raw !== "string" || !isPresetId(raw)) {
    throw new Fail("预设 ID 只许 1 到 64 个字母、数字、点、下划线和连字符，不能全是点或以点结尾。");
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
