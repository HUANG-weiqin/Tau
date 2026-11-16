// blobs 表的读写：图片的原始字节，按内容寻址；没人引用的行由 `sweepBlobs` 清（见 .knowledge/kb-store.md、设计稿 5.6）。
// 纯函数层只见到引用 `blob:<hash>`；字节只在这里和执行器调用模型之前出现。
import type { DatabaseSync } from "node:sqlite";
import type { Image } from "../images.ts";
import { IMAGE_UNSUPPORTED } from "../kernel/context.ts";
import { textContent } from "../kernel/types.ts";
import type { Content, ModelRequest } from "../kernel/types.ts";

export const BLOB_PREFIX = "blob:";

/** 信的内容块：文本，加上图片。必须在调用方的事务里调用。`accepts` 为假时不存图片，每张换成一行说明。 */
export function letterContent(db: DatabaseSync, text: string, images: readonly Image[], accepts: boolean): Content[] {
  if (images.length === 0) return textContent(text);
  if (!accepts) return textContent([...(text === "" ? [] : [text]), ...images.map(() => IMAGE_UNSUPPORTED)].join("\n"));
  putBlobs(db, images);
  return [...(text === "" ? [] : textContent(text)), ...images.map((i): Content => ({ type: "image", data: BLOB_PREFIX + i.hash, mimeType: i.mimeType }))];
}

/** 存图片，已有的不动。必须在调用方的事务里调用。 */
export function putBlobs(db: DatabaseSync, images: readonly Image[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)");
  for (const i of images) insert.run(i.hash, i.bytes);
}

/** 读一块。不开事务。 */
export function readBlob(db: DatabaseSync, hash: string): Buffer | undefined {
  const row = db.prepare("SELECT data FROM blobs WHERE hash = ?").get(hash);
  return row && Buffer.from(row.data as Uint8Array);
}

/** 请求里的图片块，引用换成 base64 的真数据。引用对不上时抛出。 */
export function resolveImages(request: ModelRequest, read: (hash: string) => Buffer | undefined): ModelRequest {
  const load = (ref: string): string => {
    const data = ref.startsWith(BLOB_PREFIX) ? read(ref.slice(BLOB_PREFIX.length)) : undefined;
    if (!data) throw new Error(`图片引用 ${ref} 在 blobs 里没有对应的行。`);
    return data.toString("base64");
  };
  const messages = request.messages.map((m) => {
    if (m.role === "assistant" || m.role === "system" || typeof m.content === "string") return m;
    return { ...m, content: m.content.map((b) => (b.type === "image" ? { ...b, data: load(b.data) } : b)) } as typeof m;
  });
  return { ...request, messages };
}
