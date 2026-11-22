// 上下文文件的视图（D72，见 .knowledge/kb-store.md）：把快照声明的文件读成开段时的快照，拼进系统提示词。
// 同步读，在事务里调用。绝不抛错：事务里抛错会让信箱卡住，读不到的文件只变成视图里的一行说明。
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { briefOf, utf8Bytes } from "../kernel/derive.ts";
import { CONTEXT_VIEW_MAX_BYTES } from "../kernel/tools.ts";
import type { PresetSnapshot } from "../kernel/types.ts";

const EMPTY = "（空文件）";
const NO_QUOTA = "（没有额度了，没读）";
/** 读不到的原因最多这么多字节，原因可能很长。 */
const REASON_MAX_BYTES = 200;
const decoder = new TextDecoder();

/** 一段里标题行后面接的内容。`cut` 表示文件内容被截了，这份额度用完了。 */
interface Body {
  text: string;
  cut: boolean;
}

/**
 * 读快照 `context` 声明的文件，拼成开段视图：每个文件一段 `### <声明的原文>` 加内容，段之间空一行。
 * 整个视图的字节数（标题行、空行、各种说明都算）不超过 `CONTEXT_VIEW_MAX_BYTES`，放不下的段不放。没有 `context` 就是空串，不读任何文件。
 * 一个文件放不下或者被截了，额度就算用完：后面的文件不再读，各写一行“没读”。每个文件读之前，先给后面每个文件的这一行留出位置，
 * 不然前面的文件一占满，后面的文件就整个消失，模型不知道它们存在。
 */
export function readContextView(preset: Pick<PresetSnapshot, "context" | "workdir">): string {
  const files = preset.context ?? [];
  let view = "";
  let spent = false;
  for (let i = 0; i < files.length; i++) {
    const name = files[i]!;
    const head = `${view === "" ? "" : "\n\n"}### ${name}\n`;
    const later = files.slice(i + 1).reduce((n, f) => n + utf8Bytes(`\n\n### ${f}\n${NO_QUOTA}`), 0);
    const room = CONTEXT_VIEW_MAX_BYTES - utf8Bytes(view) - utf8Bytes(head) - later;
    const body = spent || room < 0 ? null : readBody(resolve(preset.workdir, name), room);
    if (body === null || body.cut) spent = true;
    const text = body?.text ?? NO_QUOTA;
    if (utf8Bytes(head + text) <= CONTEXT_VIEW_MAX_BYTES - utf8Bytes(view)) view += head + text;
  }
  return view;
}

/** 读一个文件的内容，结果不超过 `room` 字节。最多读 `room + 1` 字节：多出的一个字节说明文件放不下。连一行说明都放不下时返回 null。 */
function readBody(path: string, room: number): Body | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return note("（读不到：不是普通文件）", room);
    const buf = Buffer.alloc(room + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    // 不合法的字节变成替换符；它比原来的字节长，所以解码之后还要量一次。
    const text = decoder.decode(buf.subarray(0, got));
    if (got <= room && utf8Bytes(text) <= room) return text === "" ? note(EMPTY, room) : { text, cut: false };
    const mark = `…（已截，文件共 ${got > room ? Math.max(stat.size, got) : got} 字节）`;
    const left = room - utf8Bytes(mark);
    // 按字符截：读了 room + 1 字节，末尾可能是半个字符的替换符，它总在被截掉的部分里（说明至少有几十字节）。
    return left < 0 ? null : { text: briefOf(text, left) + mark, cut: true };
  } catch (e) {
    return unreadable(e instanceof Error ? e.message : String(e), room);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也不影响视图。
      }
    }
  }
}

const note = (text: string, room: number): Body | null => (utf8Bytes(text) <= room ? { text, cut: false } : null);

/** `（读不到：<原因>）`，原因压成一行，太长就截。 */
function unreadable(reason: string, room: number): Body | null {
  const room1 = room - utf8Bytes("（读不到：）");
  return room1 < 0 ? null : { text: `（读不到：${briefOf(reason.replace(/\s+/g, " ").trim(), Math.min(room1, REASON_MAX_BYTES))}）`, cut: false };
}
