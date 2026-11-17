// 界面数据：extras/gui/state.json。先写临时文件再改名；写入串行。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpError, isObject } from "./util.ts";

export const STATE_MAX_BYTES = 1024 * 1024;

export interface StateStore {
  read(): Record<string, unknown>;
  update(set: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createStateStore(home: string): StateStore {
  const dir = path.join(home, "extras", "gui");
  const file = path.join(dir, "state.json");
  const tmp = `${file}.tmp`;
  let chain: Promise<unknown> = Promise.resolve();

  function read(): Record<string, unknown> {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new HttpError(500, "界面数据不是合法的 JSON");
    }
    if (!isObject(v)) throw new HttpError(500, "界面数据不是 JSON 对象");
    return v;
  }

  function write(set: Record<string, unknown>): Record<string, unknown> {
    const next = { ...read(), ...set };
    const text = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(text) > STATE_MAX_BYTES) throw new HttpError(413, "界面数据太大");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, file);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw e;
    }
    return next;
  }

  return {
    read,
    update(set) {
      const run = chain.then(() => write(set));
      chain = run.catch(() => {});
      return run;
    },
  };
}
