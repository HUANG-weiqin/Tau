// desktop 的 leasedIo：全用假的 raw 和 take，不调真的 send、setCursor。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Fail } from "../../../extras/tools/common.ts";
import { buttonDown, buttonUp, keyDown, keyUp, onlyReleases, WHEEL } from "../../../extras/tools/computer_lib.ts";
import type { InputEvent, Io } from "../../../extras/tools/computer_lib.ts";
import { leasedIo } from "../../../extras/tools/desktop.ts";

const K = { vk: 0x41, ext: false };

function rig(failing: boolean) {
  const log = { sends: 0, cursors: 0, stuck: 0, takes: 0 };
  const raw: Io = {
    send: () => void log.sends++,
    setCursor: () => void log.cursors++,
    sleep: async () => {},
    releaseStuck: () => void log.stuck++,
  };
  let t = 1_000_000;
  const io = leasedIo("me", raw, () => {
    log.takes++;
    if (failing) throw new Fail("桌面正被别的进程用");
  }, () => t);
  return { io, log, advance: (ms: number) => void (t += ms) };
}

test("onlyReleases：全是松开才算；空数组算（什么也不按下）；按下、滚轮、移动都不算", () => {
  assert.equal(onlyReleases([]), true);
  assert.equal(onlyReleases([keyUp(K)]), true);
  assert.equal(onlyReleases([{ kind: "unit", unit: 65, up: true }]), true);
  assert.equal(onlyReleases([buttonUp("left"), buttonUp("right"), buttonUp("middle"), keyUp(K)]), true);
  assert.equal(onlyReleases([buttonUp("left"), buttonDown("left")]), false);
  assert.equal(onlyReleases([keyUp(K), keyDown(K)]), false);
  assert.equal(onlyReleases([{ kind: "unit", unit: 65, up: false }]), false);
  assert.equal(onlyReleases([{ kind: "mouse", flags: WHEEL, data: 120 }]), false);
  assert.equal(onlyReleases([{ kind: "mouse", flags: 0x1, data: 0 }]), false); // 移动
  assert.equal(onlyReleases([buttonUp("left"), { kind: "mouse", flags: WHEEL, data: 120 }]), false);
});

test("leasedIo：拿不到租约时 send 和 setCursor 都不发出", () => {
  const { io, log } = rig(true);
  assert.throws(() => io.send([buttonDown("left")]), /桌面正被/);
  assert.throws(() => io.setCursor({ x: 1, y: 2 }), /桌面正被/);
  assert.deepEqual(log, { sends: 0, cursors: 0, stuck: 0, takes: 2 });
});

test("leasedIo：全是松开的 send 和 releaseStuck 不要租约，照样发出", () => {
  const { io, log } = rig(true);
  const ups: InputEvent[] = [buttonUp("left"), keyUp(K)];
  io.send(ups);
  io.releaseStuck();
  assert.deepEqual(log, { sends: 1, cursors: 0, stuck: 1, takes: 0 });
});

test("leasedIo：10 秒内不重复拿租约，超过再拿；sleep 不要租约", async () => {
  const { io, log, advance } = rig(false);
  io.send([buttonDown("left")]);
  io.setCursor({ x: 0, y: 0 });
  advance(9_000);
  io.send([keyDown(K)]);
  assert.equal(log.takes, 1);
  assert.equal(log.sends, 2);
  advance(2_000);
  io.send([keyDown(K)]);
  assert.equal(log.takes, 2);
  await io.sleep(1);
  assert.equal(log.takes, 2);
});
