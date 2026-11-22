// computer 的桌面租约：多个 Agent 不能同时操作鼠标和键盘。不导入 koffi，不碰真文件和真互斥量；它们都由调用方注入。
// 租约文件 {holder, at}：holder 是进程 ID，at 是最后一次输入动作的时间。30 秒没有新动作就过期。不做显式释放。
// 互斥量只包住租约文件的“读、判断、写”，不包住整个动作。
import { Fail } from "./common.ts";

export const LEASE_TTL_MS = 30000;

/** 要租约的动作：所有会发出鼠标或键盘输入的。 */
const INPUT_ACTIONS: readonly string[] = ["click", "move", "drag", "scroll", "type", "key"];
export const needsLease = (action: string): boolean => INPUT_ACTIONS.includes(action);

export type Lease = { holder: string; at: number };

export type LeaseIo = {
  /** 在系统互斥量里跑 fn。拿不到就抛 Fail。 */
  withMutex: <T>(fn: () => T) => T;
  /** 租约文件的原文；文件不存在返回 null。 */
  read: () => string | null;
  /** 原子地写租约文件。 */
  write: (text: string) => void;
  now: () => number;
};

/** 解析租约文件；不存在、损坏或字段不对都当没人占。 */
export function parseLease(text: string | null): Lease | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null) return null;
    if (typeof v["holder"] !== "string" || v["holder"] === "" || typeof v["at"] !== "number" || !Number.isFinite(v["at"])) return null;
    return { holder: v["holder"], at: v["at"] };
  } catch {
    return null;
  }
}

/** 纯判断：返回 null 表示 proc 可以拿，否则返回给模型看的错误。 */
export function leaseConflict(lease: Lease | null, proc: string, now: number): string | null {
  // at 在将来：多半是时钟往回调过，这种租约不能让别人等一个小时，当作过期。
  if (lease === null || lease.holder === proc || lease.at > now || now - lease.at > LEASE_TTL_MS) return null;
  return `桌面正被进程 ${lease.holder} 用，租约到期前别的进程不能操作。稍后再试。`;
}

/** 在任何输入发出之前调用。拿不到抛 Fail，拿到就写入 {holder: proc, at: now}。 */
export function acquireLease(proc: string, io: LeaseIo): void {
  io.withMutex(() => {
    const now = io.now();
    const problem = leaseConflict(parseLease(io.read()), proc, now);
    if (problem !== null) throw new Fail(problem);
    io.write(JSON.stringify({ holder: proc, at: now } satisfies Lease));
  });
}

/** 续租的间隔：上次成功拿租约到现在超过这么久才再拿。租约 30 秒过期，10 秒续一次有余量。 */
export const LEASE_RENEW_MS = 10000;

/** 返回一个“确保持有租约”的函数：第一次一定调 take，之后每隔 everyMs 再调一次。
 *  take 抛错就不记成功时间，错误往外抛，下次还会调。 */
export function leaseKeeper(take: () => void, now: () => number, everyMs = LEASE_RENEW_MS): () => void {
  let last: number | null = null;
  return () => {
    const t = now();
    if (last !== null && t >= last && t - last <= everyMs) return;
    take();
    last = t;
  };
}
