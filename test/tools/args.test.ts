// 弱模型填参数常出错（D109）。内置工具做全套整理：归一、别名、丢说明性参数、转标量；工具定义按契约只修 null 和字符串化的容器。库内和库外共用这一处。
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBuiltin } from "../../src/kernel/tools.ts";
import { textContent } from "../../src/kernel/types.ts";
import { fixArgs, noted, usage } from "../../src/tools/args.ts";

const fix = (name: string, args: Record<string, unknown>) => fixArgs(findBuiltin(name)!, { arguments: args as never }, true);
const ok = (name: string, args: Record<string, unknown>) => {
  const r = fix(name, args);
  assert.ok("args" in r, "error" in r ? r.error : "");
  return { args: { ...r.args }, notes: r.notes };
};
const err = (name: string, args: Record<string, unknown>) => {
  const r = fix(name, args);
  assert.ok("error" in r, JSON.stringify(r));
  return r.error;
};

test("参数名归一：大小写、下划线、驼峰、file 前缀、string/str/text 后缀、末尾数字", () => {
  assert.deepEqual(ok("edit", { file_path: "a", old_string: "x", new_string: "y", replace_all: true }), {
    args: { path: "a", old: "x", new: "y", replaceAll: true },
    notes: ["参数 file_path 当作 path", "参数 old_string 当作 old", "参数 new_string 当作 new", "参数 replace_all 当作 replaceAll"],
  });
  assert.deepEqual(ok("edit", { filePath: "a", oldText: "x", new_str: "y" }).args, { path: "a", old: "x", new: "y" });
  assert.deepEqual(ok("memory_set", { Key: "k", VALUE: "v", Brief: "b" }).args, { key: "k", value: "v", brief: "b" });
  assert.deepEqual(ok("write", { path: "a", contents: "x" }).args, { path: "a", content: "x" });
});

test("同一参数给了两次：值一样留一个并说明（deepseek 真实的 new2），值不一样拒绝", () => {
  assert.deepEqual(ok("edit", { path: "a", old: "x", new: "y", new2: "y" }), { args: { path: "a", old: "x", new: "y" }, notes: ["参数 new2 重复，没用上"] });
  assert.match(err("read", { path: "a", path2: "b" }), /^参数错误：path 给了两次，值不一样。/);
  assert.deepEqual(ok("read", { file_path: "a", path: "a" }).notes, ["参数 file_path 重复，没用上"], "名字正好是参数名的先放");
  assert.deepEqual(ok("bash", { command: "ls", cmd: "ls" }).notes, ["没用上参数 cmd"], "和已给的字符串参数同值的副本：丢掉");
  assert.deepEqual(ok("memory_set", { name: "memory_set", key: "k", value: "v", brief: "b" }).notes, ["没用上参数 name"], "值等于工具名");
});

test("别名表：只认必填或可选里还空着的目标；别的名字不猜", () => {
  assert.deepEqual(ok("memory_set", { key: "k", content: "v", brief: "b" }).notes, ["参数 content 当作 value"]);
  assert.deepEqual(ok("memory_set", { key: "k", value: "v", description: "摘要" }).args, { key: "k", value: "v", brief: "摘要" });
  assert.deepEqual(ok("memory_edit", { key: "k", old: "a", new: "b", version: 1, summary: "新摘要" }).notes, ["没用上参数 summary"], "可选的 brief 不认别名：说明性的参数丢掉");
  assert.deepEqual(ok("post", { to: "p", message: "hi" }).args, { to: "p", text: "hi" });
  assert.deepEqual(ok("spawn", { preset: "kid", prompt: "go" }).args, { preset: "kid", text: "go" });
  assert.deepEqual(ok("bash", { cmd: "ls" }).args, { command: "ls" });
  assert.deepEqual(ok("stop_process", { id: "p" }).args, { process: "p" });
  assert.deepEqual(ok("memory_get", { name: "k" }).args, { key: "k" });
  assert.deepEqual(ok("post", { process: "p", text: "x" }).args, { to: "p", text: "x" });
  assert.deepEqual(ok("spawn", { subagent_type: "kid", task: "go" }).args, { preset: "kid", text: "go" });
  assert.deepEqual(ok("write", { target_file: "a", file_text: "x" }).args, { path: "a", content: "x" });
  assert.match(err("memory_get", { ver: 3 }), /不认识参数 ver/, "没有出处的别名不收");
  assert.deepEqual(ok("read", { file: "a" }).args, { path: "a" });
});

test("不在别名表里的、会改语义的、已经给了的：拒绝，不猜", () => {
  assert.match(err("post", { to: "p", subject: "周报" }), /^参数错误：不认识参数 subject；缺少 text。/, "按排除法猜会把标题当正文寄出去");
  assert.match(err("spawn", { preset: "kid", cwd: "D:/w" }), /不认识参数 cwd；缺少 text/);
  assert.match(err("bash", { description: "rm build artifacts" }), /^参数错误：缺少 command。/, "说明性参数不会被当成命令");
  assert.match(err("memory_set", { key: "k", brief: "b", append: "- 任务 C" }), /不认识参数 append；缺少 value/, "追加不能被当成整个值");
  assert.match(err("memory_edit", { key: "k", new: "x", insert_after: "y", version: 1 }), /不认识参数 insert_after；缺少 old/);
  assert.match(err("edit", { path: "a", search: "x", replace: "y" }), /不认识参数 search、replace；缺少 old、new/);
  assert.match(err("write", { path: "a", content: "x", append: true }), /不认识参数 append/);
});

test("说明性参数丢掉并说明；无参工具丢掉全部多余参数；有参工具的多余参数拒绝并带参数表", () => {
  assert.deepEqual(ok("bash", { command: "ls", description: "列文件", requires_approval: false }), { args: { command: "ls" }, notes: ["没用上参数 description、requires_approval"] });
  assert.deepEqual(ok("handoff", { summary: "做到第 3 步" }), { args: {}, notes: ["没用上参数 summary"] });
  assert.deepEqual(ok("self", { verbose: true }).args, {});
  assert.deepEqual(ok("read", { path: "a", should_read_entire_file: true }).notes, ["没用上参数 should_read_entire_file"]);
  const e = err("read", { path: "a", start_line: 1500, end_line: 1510 });
  assert.match(e, /^参数错误：不认识参数 start_line、end_line。read 的参数：path（字符串，必填）、offset（整数，可选）、limit（整数，可选）。照这样调用：read\(\{"path": …\}\)$/, "读的范围不能悄悄丢掉：read 要有 offset 和 limit 可抄");
  assert.match(err("memory_get", { key: "k", ns: "chief" }), /不认识参数 ns/, "跨库读不到：不能悄悄读自己的");
  assert.match(err("post", { to: "p", text: "x", cc: "q" }), /不认识参数 cc/);
});

test("标量：整数认整数值的字符串、不截小数；布尔认 yes/no、1/0、大小写；可选的空串和 none 当没填", () => {
  assert.deepEqual(ok("read", { path: "a", offset: " 2 ", limit: "3.0" }).args, { path: "a", offset: 2, limit: 3 });
  for (const v of ["+3", "3e0", "0x3", "3.01", "30s"]) assert.match(err("read", { path: "a", offset: v }), /offset 要整数/, v);
  assert.match(err("read", { path: "a", offset: 1.5 }), /offset 要整数，收到的是 1\.5/);
  for (const [v, want] of [["yes", true], ["No", false], [1, true], ["0", false], ["TRUE", true], ["y", true]] as const) assert.equal(ok("post", { to: "p", text: "x", reply: v }).args.reply, want, String(v));
  assert.match(err("post", { to: "p", text: "x", reply: "maybe" }), /reply 要布尔值，收到的是 "maybe"/);
  assert.deepEqual(ok("bash", { command: "ls", timeout: "" }).args, { command: "ls" }, "空串不再被转成 0（立刻转后台）");
  assert.deepEqual(ok("read", { path: "a", offset: "None" }).args, { path: "a" });
  assert.deepEqual(ok("write", { path: "a", content: 123 }).args, { path: "a", content: "123" });
});

test("字符串参数给了对象或数组：说清收到的是什么，不说“缺少”", () => {
  assert.match(err("bash", { command: ["ls", "-la"] }), /^参数错误：command 要字符串，收到的是 数组。bash 的参数：/);
  assert.match(err("memory_set", { key: "k", value: { a: 1 }, brief: "b" }), /^参数错误：value 要字符串，收到的是 对象。/);
  assert.match(err("memory_set", { key: "k", value: "v", brief: ["x"] }), /^参数错误：brief 要字符串，收到的是 数组。/);
});

test("必填的 null：说清是哪个和怎么写空值；可选的 null 当没填", () => {
  assert.equal(err("edit", { path: "a", old: "x", new: null }), '参数错误：new 是 null，必填（空的写 ""）。edit 的参数：path（字符串，必填）、old（字符串，必填）、new（字符串，必填）、replaceAll（布尔值，可选）。照这样调用：edit({"path": …, "old": …, "new": …})');
  assert.deepEqual(ok("read", { path: "a", offset: null, junk: null }).args, { path: "a" });
});

test("记忆工具的 brief、version 由记忆分支处理：缺了、是 null、不是整数都不在这里报错", () => {
  assert.deepEqual(ok("memory_set", { key: "k", value: "v" }), { args: { key: "k", value: "v" }, notes: [] });
  assert.deepEqual(ok("memory_set", { key: "k", value: "v", brief: null, version: null }).args, { key: "k", value: "v" });
  assert.deepEqual(ok("memory_set", { key: "k", value: "v", version: "latest" }).args, { key: "k", value: "v", version: "latest" });
  assert.deepEqual(ok("memory_delete", { key: "k" }).args, { key: "k" });
  assert.deepEqual(ok("memory_edit", { key: "k", old: "a", new: "b", version: 1.5 }).args.version, 1.5);
  assert.deepEqual(ok("memory_delete", { key: "k", version: "3.0" }).args, { key: "k", version: 3 });
  assert.deepEqual(ok("memory_delete", { key: "k", version: "" }).args, { key: "k" });
  assert.match(err("memory_set", { key: "k", brief: "b" }), /^参数错误：缺少 value。/);
  assert.match(err("memory_set", { key: "k", value: null, brief: "b" }), /^参数错误：value 是 null，必填/);
});

test("参数的 JSON 坏了：中文说清怎么写，带参数表；无参工具照常执行", () => {
  const r = fixArgs(findBuiltin("memory_get")!, { arguments: {}, argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n\"{}\"" }, true);
  assert.deepEqual(r, { error: '参数错误：参数不是一个合法的 JSON 对象。重发时写成一个对象：键和字符串都用双引号，字符串里的双引号写成 \\"，反斜杠写成 \\\\；不要把整个参数再包成字符串，不要加 ```，一次调用只放一个对象。memory_get 的参数：key（字符串，必填）。照这样调用：memory_get({"key": …})' });
  for (const name of ["self", "handoff"]) assert.deepEqual(fixArgs(findBuiltin(name)!, { arguments: {}, argumentsError: "Unexpected end of JSON input" }, true), { args: {}, notes: ["参数不是合法的 JSON，没用上"] }, `${name} 没有参数，照常执行`);
});

test("叫 __proto__ 的参数是普通的键", () => {
  assert.match(err("write", JSON.parse('{"path":"a","content":"x","__proto__":{"y":1}}')), /不认识参数 __proto__/);
  assert.deepEqual(ok("handoff", JSON.parse('{"__proto__":{"y":1}}')).notes, ["没用上参数 __proto__"]);
});

test("工具定义：只修 null 和字符串化的容器，别名、多余参数、标量都交给 schema 校验（契约）", () => {
  const def = { name: "t", parameters: { type: "object", properties: { text: { type: "string" }, items: { type: "array" } }, required: ["text"] } };
  assert.deepEqual(fixArgs(def, { arguments: { Text: "x", items: '["a"]', n: "3", extra: null } as never }, false), { args: { Text: "x", items: ["a"], n: "3" }, notes: [] });
  assert.match((fixArgs(def, { arguments: { text: null } as never }, false) as { error: string }).error, /^参数错误：text 是 null/);
  const proto = fixArgs(def, { arguments: JSON.parse('{"text":"x","__proto__":{"y":1}}') }, false);
  assert.deepEqual(Object.keys("args" in proto ? proto.args : {}), ["text", "__proto__"], "叫 __proto__ 的参数留着，让校验拒绝");
  assert.match((fixArgs(def, { arguments: {}, argumentsError: "x" }, false) as { error: string }).error, /^参数错误：参数不是一个合法的 JSON 对象。/);
});

test("注：接在最后一个文本块后面；没有说明原样返回；没有文本块就加一块；isError 不变", () => {
  const r = { content: textContent("已写入 k，版本 1。"), isError: false };
  assert.deepEqual(noted(r, ["参数 content 当作 value", "没用上参数 title"]).content, textContent("已写入 k，版本 1。\n注：参数 content 当作 value；没用上参数 title。"));
  assert.equal(noted(r, []), r);
  assert.deepEqual(noted({ content: [{ type: "image", data: "blob:x", mimeType: "image/png" }], isError: true }, ["x"]), { content: [{ type: "image", data: "blob:x", mimeType: "image/png" }, { type: "text", text: "注：x。" }], isError: true });
  assert.equal(usage(findBuiltin("self")!), "self 的参数：无。照这样调用：self({})");
});

test("bash 的工作目录键（cwd、workdir 等）：命令前加 cd，失败就不跑原命令；第二个目录键不猜", () => {
  const r = ok("bash", { command: "ls", cwd: "D:/proj" });
  assert.deepEqual(r, { args: { command: "cd -- 'D:/proj' || exit\nls" }, notes: ["参数 cwd 当作命令前的 cd -- 'D:/proj'"] });
  assert.equal(ok("bash", { cmd: "ls", Work_Dir: "/c/it's" }).args.command, "cd -- '/c/it'\\''s' || exit\nls", "别名改名之后再处理，单引号照写");
  assert.match(err("bash", { command: "ls", cwd: "a", workdir: "b" }), /不认识参数 workdir/);
  assert.match(err("bash", { cwd: "a" }), /缺少 command/);
  assert.match(err("read", { path: "a", cwd: "D:/x" }), /不认识参数 cwd/, "只有 bash 认");
});

test("write 带 append：拒绝，给出 bash 的两种写法", () => {
  assert.match(err("write", { path: "a", content: "x", append: true }), /不认识参数 append（write 总是整份覆盖。要追加，用 bash：cat >> 文件 <<'EOF'；文件已存在就不写，用 bash：set -C; cat > 文件 <<'EOF'）。write 的参数/);
});

test("注：转后台的 bash 结果不加：固定的一段必须留在末尾", () => {
  const bg = "[转入后台 abcdef] 命令还在运行，没有被结束。\n输出文件：C:/x.log（还在增长，用 read 读，可带 offset 和 limit）\n跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。";
  const r = { content: textContent(bg), isError: false };
  assert.equal(noted(r, ["没用上参数 description"]), r);
  assert.equal(noted({ content: textContent("hi\n[退出码 0]"), isError: false }, ["没用上参数 description"]).content[0]?.type === "text" && "ok", "ok");
});
