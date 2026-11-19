// api key 的检查：界面的桥（keys.ts）和登录脚本（login.ts）共用。返回存进去的值（trim 后）。错误文字里没有 key 的任何字符。
const KEY_MAX_BYTES = 4096;

export function checkKey(key: unknown): string {
  if (typeof key !== "string") throw new Error("key 必须是字符串");
  const k = key.trim();
  if (k === "") throw new Error("key 不能是空的");
  if (/[\u0000-\u001f\u007f]/.test(k)) throw new Error("key 里不能有控制字符或换行");
  if (Buffer.byteLength(k) > KEY_MAX_BYTES) throw new Error(`key 超过 ${KEY_MAX_BYTES} 字节`);
  if (k.startsWith("!") || k.includes("$")) throw new Error("key 不能以 ! 开头或含 $：tau 不执行命令也不展开变量");
  return k;
}
