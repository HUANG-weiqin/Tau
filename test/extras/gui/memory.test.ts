// 记忆页的纯函数（extras/gui/web/lib/memory.js），读回复的部分对着真的测试服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { sqliteMemory } from "../../../src/memory/kv.ts";
import { serve } from "../../../src/server/serve.ts";
import { createBridge } from "../../../extras/gui/bridge/server.ts";
import { afterConflict, byKeyBytes, dayOf, deleteOp, editDirty, editError, editOf, interpretWrite, isLong, newEdit, overText, preview, setOp, sortEntries, utf8Bytes } from "../../../extras/gui/web/lib/memory.js";

const E = (key: string, value = "v", version = 1, brief = `${key} 的摘要`, updated = new Date(2026, 10, 19, 12).getTime()) => ({ key, value, version, brief, updated });

test("memory: 排序按键的 UTF-8 字节序，不按 UTF-16 码元", () => {
  // U+FF5E（3 字节，EF）比 U+10000（4 字节，F0）小；UTF-16 里代理项 D800 比 FF5E 小。
  const got = sortEntries([E("\u{10000}"), E("b"), E("～"), E("a"), E("中")]).map((x) => x.key);
  assert.deepEqual(got, ["a", "b", "中", "～", "\u{10000}"]);
  assert.ok(byKeyBytes("a", "ab") < 0 && byKeyBytes("ab", "a") > 0 && byKeyBytes("a", "a") === 0);
  const input = [E("b"), E("a")];
  sortEntries(input);
  assert.equal(input[0]!.key, "b", "不改原数组");
});

test("memory: 折叠预览，多行或长的才折", () => {
  assert.equal(isLong("短"), false);
  assert.equal(isLong("一行\n两行"), true);
  assert.equal(isLong("字".repeat(80)), false);
  assert.equal(isLong("字".repeat(81)), true);
  assert.equal(preview("第一行\n第二行"), "第一行");
  assert.equal(preview("字".repeat(100)), `${"字".repeat(80)}…`);
  assert.equal(utf8Bytes("中a"), 4);
});

test("memory: 编辑状态：没改不能存，新键必须有键名且不重名", () => {
  const e = editOf(E("k", "旧", 7, "旧摘要"));
  assert.deepEqual(e, { key: "k", draft: "旧", brief: "旧摘要", base: 7, isNew: false, orig: "旧", origBrief: "旧摘要" });
  assert.equal(editDirty(e), false);
  assert.equal(editDirty({ ...e, draft: "新" }), true);
  assert.equal(editDirty({ ...e, brief: "新摘要" }), true);
  assert.equal(editDirty({ ...e, draft: "旧", brief: "旧摘要" }), false);
  assert.equal(editError(e, [E("k")]), null);
  // 改已有的键不查摘要。
  assert.equal(editError({ ...e, brief: "" }, [E("k")]), null);

  const n = newEdit();
  assert.equal(n.base, null);
  assert.equal(n.brief, "");
  assert.equal(n.origBrief, "");
  assert.match(editError(n, []) ?? "", /不能为空/);
  // 空键先报键。
  assert.equal(editError({ ...n, key: "" }, []), "键不能为空");
  // 新键的摘要不能为空，只有空白也不算。
  assert.equal(editError({ ...n, key: "j" }, [E("k")]), "摘要不能为空");
  assert.equal(editError({ ...n, key: "j", brief: "  " }, [E("k")]), "摘要不能为空");
  assert.equal(editError({ ...n, key: "j", brief: "一句话" }, [E("k")]), null);
  // 摘要为空时先报摘要，再报重名。
  assert.equal(editError({ ...n, key: "k" }, [E("k")]), "摘要不能为空");
  assert.match(editError({ ...n, key: "k", brief: "一句话" }, [E("k")]) ?? "", /已经有/);
});

test("memory: 写操作带读到的版本号；新键 expected 是 null；保存总带摘要", () => {
  assert.deepEqual(setOp("p", editOf(E("k", "旧", 7, "旧摘要"))), { kind: "set", ns: "p", key: "k", value: "旧", brief: "旧摘要", expected: 7 });
  assert.deepEqual(setOp("p", { ...newEdit(), key: "n", draft: "x", brief: "一句话" }), { kind: "set", ns: "p", key: "n", value: "x", brief: "一句话", expected: null });
  // 只改值，摘要带原来的。
  const changed = { ...editOf(E("k", "旧", 7, "旧摘要")), draft: "新" };
  assert.deepEqual(setOp("p", changed), { kind: "set", ns: "p", key: "k", value: "新", brief: "旧摘要", expected: 7 });
  assert.deepEqual(deleteOp("p", E("k", "v", 9)), { kind: "delete", ns: "p", key: "k", expected: 9 });
});

test("memory: 读写回复：成功、冲突（带最新值和摘要，或键已被删）、超限、读不懂", () => {
  assert.deepEqual(interpretWrite({ type: "memory_written", versions: [12] }), { kind: "ok", version: 12 });
  assert.deepEqual(interpretWrite({ type: "memory_written", versions: [null] }), { kind: "ok", version: null });
  const cur = { value: "别人的", brief: "别人的摘要", updated: 1_700_000_000_000, version: 20 };
  assert.deepEqual(interpretWrite({ type: "memory_rejected", index: 0, result: { ok: false, current: cur } }), { kind: "conflict", current: cur });
  assert.deepEqual(interpretWrite({ type: "memory_rejected", index: 0, result: { ok: false, current: null } }), { kind: "conflict", current: null });
  assert.deepEqual(interpretWrite({ type: "memory_rejected", index: 0, result: { ok: false, over: "value", bytes: 5000 } }), { kind: "over", over: "value", bytes: 5000 });
  assert.deepEqual(interpretWrite({ type: "nope" }), { kind: "unknown" });
  assert.deepEqual(interpretWrite(null), { kind: "unknown" });
  assert.match(overText("key", 200), /键太长.*200/);
  assert.match(overText("value", 5000), /值太长.*5000/);
  assert.match(overText("view", 20000), /整个库.*20000/);
  // 旧服务可能发来新内核不再产生的 over（D96 删了 brief）：走兜底，不能冒充成 view 的说明。
  assert.match(overText("brief" as never, 300), /有一项超出记忆库的上限.*300/);
});

test("memory: 版本冲突：用户写的字和摘要原样留着，版本号换成别处现在的，别处的值和摘要给他对照", () => {
  const mine = { ...editOf(E("k", "旧", 7, "旧摘要")), draft: "我写的", brief: "我写的摘要" };
  const a = afterConflict(mine, { value: "别人写的", brief: "别人的摘要", updated: 1_700_000_000_000, version: 20 });
  assert.equal(a.draft, "我写的");
  assert.equal(a.brief, "我写的摘要");
  assert.equal(a.base, 20);
  assert.deepEqual(a.other, { value: "别人写的", brief: "别人的摘要" });
  assert.equal(a.orig, "旧");
  assert.equal(a.origBrief, "旧摘要");
  assert.equal(editDirty(a), true);
  // 我写的和别人写的一样：没有可存的。
  assert.equal(editDirty({ ...a, draft: "别人写的", brief: "别人的摘要" }), false);
  // 只差摘要也算改了。
  assert.equal(editDirty({ ...a, draft: "别人写的" }), true);
  // 别处把键删了：版本号回到 null，保存就是重建。
  const g = afterConflict(mine, null);
  assert.equal(g.draft, "我写的");
  assert.equal(g.brief, "我写的摘要");
  assert.equal(g.base, null);
  assert.deepEqual(g.other, { gone: true });
  assert.equal(editDirty({ ...g, draft: "旧", brief: "旧摘要" }), true);
  assert.deepEqual(setOp("p", g), { kind: "set", ns: "p", key: "k", value: "我写的", brief: "我写的摘要", expected: null });
  // 新键撞上别人刚建的同名键：成了改已有的键，再按保存不被“已经有这个键”拦住。
  const n = afterConflict({ ...newEdit(), key: "n", draft: "x", brief: "一句话" }, { value: "y", brief: "别人的摘要", updated: 1_700_000_000_000, version: 30 });
  assert.equal(n.base, 30);
  assert.equal(n.isNew, false);
  assert.equal(n.draft, "x");
  assert.equal(n.brief, "一句话");
  assert.deepEqual(n.other, { value: "y", brief: "别人的摘要" });
  assert.equal(editError(n, [E("n")]), null);
});

test("memory: 更新日期用本地时区，写 YYYY-MM-DD", () => {
  assert.equal(dayOf(new Date(2026, 10, 19, 12).getTime()), "2026-11-19");
  assert.equal(dayOf(new Date(2026, 0, 5, 12).getTime()), "2026-01-05");
  assert.equal(dayOf(new Date(2026, 11, 31, 0, 0, 1).getTime()), "2026-12-31");
});

test("memory: 经桥读写真的服务：新键、改、冲突不覆盖、删；回复正好是 interpretWrite 读得懂的", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tau-gui-mem-"));
  mkdirSync(join(dir, "presets"));
  const pipe = `\\\\.\\pipe\\tau-test-gui-mem-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const svc = await serve({ pipe, dbPath: join(dir, "tau.db"), presetsDir: join(dir, "presets"), toolsDir: join(dir, "tools"), models: createModels(), memory: sqliteMemory });
  const bridge = await createBridge({ port: 0, home: join(dir, "home"), pipe });
  t.after(async () => {
    await bridge.close();
    await svc.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const tau = async (body: unknown): Promise<any[]> => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/tau`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.text()).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  };
  const read = async () => (await tau({ op: "memory", ns: "proj" }))[0].entries as { key: string; value: string; brief: string; updated: number; version: number }[];
  const write = async (op: unknown) => (await tau({ op: "memory_write", ops: [op] }))[0];

  // 空库。
  assert.deepEqual(await read(), []);
  // 新键。
  const made = interpretWrite(await write(setOp("proj", { ...newEdit(), key: "城市", draft: "上海", brief: "住在哪" })));
  assert.equal(made.kind, "ok");
  const [first] = await read();
  assert.deepEqual({ key: first!.key, value: first!.value, brief: first!.brief }, { key: "城市", value: "上海", brief: "住在哪" });
  assert.ok(first!.updated > 1_700_000_000_000, "updated 是服务写入时的毫秒数");
  // 我开始改（版本 v1），兄弟进程先写了。
  const mine = { ...editOf(first!), draft: "北京" };
  const sibling = interpretWrite(await write(setOp("proj", { ...editOf(first!), draft: "深圳", brief: "搬家了" })));
  assert.equal(sibling.kind, "ok");
  const clash = interpretWrite(await write(setOp("proj", mine)));
  assert.equal(clash.kind, "conflict");
  assert.equal((await read())[0]!.value, "深圳", "冲突时没有覆盖");
  if (clash.kind !== "conflict") return;
  // 带着别处现在的版本再存，才写进去。
  const again = afterConflict(mine, clash.current);
  assert.equal(again.draft, "北京");
  assert.deepEqual(again.other, { value: "深圳", brief: "搬家了" });
  assert.equal(interpretWrite(await write(setOp("proj", again))).kind, "ok");
  const [now] = await read();
  assert.equal(now!.value, "北京");
  assert.equal(now!.brief, "住在哪", "用户没动摘要，存的是他自己的，不是别处的");
  // 删：版本旧了冲突，现在的版本才删得掉；已经没有的键，冲突带 null。
  assert.equal(interpretWrite(await write(deleteOp("proj", first!))).kind, "conflict");
  assert.equal(interpretWrite(await write(deleteOp("proj", now!))).kind, "ok");
  assert.deepEqual(await read(), []);
  assert.deepEqual(interpretWrite(await write(deleteOp("proj", now!))), { kind: "conflict", current: null });
  // 新键撞上别人刚建的同名键：冲突。
  await write(setOp("proj", { ...newEdit(), key: "k", draft: "a", brief: "甲" }));
  assert.equal(interpretWrite(await write(setOp("proj", { ...newEdit(), key: "k", draft: "b", brief: "乙" }))).kind, "conflict");
  // 只改值：摘要还是原来那句，不会退回值的前缀。
  const [k] = await read();
  assert.equal(interpretWrite(await write(setOp("proj", { ...editOf(k!), draft: "a2" }))).kind, "ok");
  const [k2] = await read();
  assert.deepEqual({ value: k2!.value, brief: k2!.brief }, { value: "a2", brief: "甲" });
  // 只改摘要：值不变。
  assert.equal(interpretWrite(await write(setOp("proj", { ...editOf(k2!), brief: "丙" }))).kind, "ok");
  const [k3] = await read();
  assert.deepEqual({ value: k3!.value, brief: k3!.brief }, { value: "a2", brief: "丙" });
  // 超限。
  const big = interpretWrite(await write(setOp("proj", { ...newEdit(), key: "big", draft: "字".repeat(2000), brief: "x" })));
  assert.equal(big.kind, "over");
  if (big.kind === "over") assert.equal(big.over, "value");
});
