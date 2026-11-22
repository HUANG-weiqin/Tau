// computer 租约：纯函数加假的 io。不碰真互斥量、真文件和真输入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fail } from "../../../extras/tools/common.ts";
import { pruneComputerImages } from "../../../extras/tools/computer_lib.ts";
import { LEASE_TTL_MS, acquireLease, needsLease, parseLease } from "../../../extras/tools/computer_lease.ts";
import type { LeaseIo } from "../../../extras/tools/computer_lease.ts";

const NOW = 1_000_000;

/** 假 io：记下写了什么、互斥量进出几次。 */
function fake(file: string | null, mutex: "ok" | "busy" = "ok") {
  const log = { writes: [] as string[], entered: 0, left: 0 };
  const io: LeaseIo = {
    withMutex: (fn) => {
      if (mutex === "busy") throw new Fail("桌面租约正被占用，稍后再试。");
      log.entered++;
      try {
        return fn();
      } finally {
        log.left++;
      }
    },
    read: () => file,
    write: (t) => void log.writes.push(t),
    now: () => NOW,
  };
  return { io, log };
}

test("needsLease：只有输入动作要", () => {
  for (const a of ["click", "move", "drag", "scroll", "type", "key"]) assert.equal(needsLease(a), true, a);
  for (const a of ["screenshot", "zoom", "wait"]) assert.equal(needsLease(a), false, a);
});

test("parseLease：损坏或字段不对都是 null", () => {
  assert.equal(parseLease(null), null);
  assert.equal(parseLease("{坏的"), null);
  assert.equal(parseLease("null"), null);
  assert.equal(parseLease(`{"holder":1,"at":5}`), null);
  assert.equal(parseLease(`{"holder":"a"}`), null);
  assert.deepEqual(parseLease(`{"holder":"a","at":5}`), { holder: "a", at: 5 });
});

test("acquireLease：没文件、损坏、同一 holder、过期都能拿，并写入新租约", () => {
  const cases: (string | null)[] = [
    null,
    "{坏的",
    JSON.stringify({ holder: "me", at: NOW - 1 }),
    JSON.stringify({ holder: "other", at: NOW - LEASE_TTL_MS - 1 }),
    JSON.stringify({ holder: "other", at: NOW + 3600000 }),
  ];
  for (const file of cases) {
    const { io, log } = fake(file);
    acquireLease("me", io);
    assert.deepEqual(log.writes.map((w) => JSON.parse(w)), [{ holder: "me", at: NOW }], String(file));
    assert.equal(log.entered, 1);
    assert.equal(log.left, 1);
  }
});

test("acquireLease：被别人占着就报错带 holder，不写文件，互斥量照样放掉", () => {
  const { io, log } = fake(JSON.stringify({ holder: "other", at: NOW - 1000 }));
  assert.throws(() => acquireLease("me", io), (e: unknown) => e instanceof Fail && e.message.includes("进程 other"));
  assert.deepEqual(log.writes, []);
  assert.equal(log.entered, log.left);
});

test("acquireLease：互斥量拿不到就报错，不读不写", () => {
  const { io, log } = fake(null, "busy");
  assert.throws(() => acquireLease("me", io), /桌面租约正被占用/);
  assert.deepEqual(log.writes, []);
});

test("pruneComputerImages：不删 root 下的 lease.json 和 lease.json.tmp", () => {
  const root = mkdtempSync(join(tmpdir(), "tau-lease-"));
  try {
    writeFileSync(join(root, "lease.json"), "{}");
    writeFileSync(join(root, "lease.json.tmp"), "{}");
    mkdirSync(join(root, "p"));
    pruneComputerImages(root, Date.now() + 10 * 3600_000);
    assert.equal(existsSync(join(root, "lease.json")), true);
    assert.equal(existsSync(join(root, "lease.json.tmp")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
