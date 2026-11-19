// 填写和清除 ~/.tau/auth.json 里的 api_key，登出 OAuth（D69、D83）。读、改、写都走凭据库的 modify：持锁，先写临时文件再改名。
// key 的值不进返回值、错误文字。不导入 src/。
import type { CredentialStore } from "@earendil-works/pi-ai";
import { checkKey as check } from "../../auth/key.ts";
import { HttpError } from "./util.ts";

/** 检查不过是 400。规则在 extras/auth/key.ts，登录脚本共用。 */
function checkKey(key: unknown): string {
  try {
    return check(key);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

/** 凭据库的错误（文件坏了、被占着、写不了）原样告诉用户，说明没有改。错误文字不带文件内容。 */
async function guard(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, `${e instanceof Error ? e.message : String(e)}没有改它。`);
  }
}

/** 这一家已有 api_key 条目的其它字段（例如 `env`）原样留着，只换 key。已经是 OAuth 登录的，先登出。 */
export async function setKey(store: CredentialStore, provider: string, key: unknown): Promise<void> {
  const k = checkKey(key);
  await guard(() =>
    store.modify(provider, async (cur) => {
      if (cur?.type === "oauth") throw new HttpError(409, "这一家是 OAuth 登录的，先登出再填 key");
      return { ...cur, type: "api_key", key: k };
    }),
  );
}

/** 清掉 api_key，或登出 OAuth：删掉这一家的条目，别家原样。没有这一家就什么也不做。 */
export async function clearKey(store: CredentialStore, provider: string): Promise<void> {
  await guard(() => store.delete(provider));
}
