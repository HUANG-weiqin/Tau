// computer 工具的系统调用：koffi 绑定 user32、gdi32、kernel32，加薄封装。判断和换算在 computer_lib.ts。
// 任何一步失败都抛 Fail，不返回黑图，不假装成功。
import koffi from "koffi";
import { Fail } from "./common.ts";
import { stuckEvents } from "./computer_lib.ts";
import type { InputEvent, Point, Rect, Size } from "./computer_lib.ts";

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const kernel32 = koffi.load("kernel32.dll");

const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32_t",
  biWidth: "int32_t",
  biHeight: "int32_t",
  biPlanes: "uint16_t",
  biBitCount: "uint16_t",
  biCompression: "uint32_t",
  biSizeImage: "uint32_t",
  biXPelsPerMeter: "int32_t",
  biYPelsPerMeter: "int32_t",
  biClrUsed: "uint32_t",
  biClrImportant: "uint32_t",
});

const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "int32_t",
  dy: "int32_t",
  mouseData: "uint32_t",
  dwFlags: "uint32_t",
  time: "uint32_t",
  dwExtraInfo: "uintptr_t",
});
const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16_t",
  wScan: "uint16_t",
  dwFlags: "uint32_t",
  time: "uint32_t",
  dwExtraInfo: "uintptr_t",
});
const INPUT_UNION = koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT });
const INPUT = koffi.struct("INPUT", { type: "uint32_t", u: INPUT_UNION });

// x64 上 INPUT 是 40 字节，type 在偏移 0，联合体在偏移 8。布局不对就别发：SendInput 会返回 0 或发出乱码。
if (koffi.sizeof(INPUT) !== 40 || koffi.offsetof(INPUT, "u") !== 8) throw new Fail("INPUT 结构的布局不是 x64 的 40 字节：这个工具只支持 64 位的 Windows。");
const INPUT_SIZE = 40;

const SetProcessDpiAwarenessContext = user32.func("int __stdcall SetProcessDpiAwarenessContext(intptr_t)");
const SetThreadDpiAwarenessContext = user32.func("intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int)");
const OpenInputDesktop = user32.func("void *__stdcall OpenInputDesktop(uint32_t, int, uint32_t)");
const CloseDesktop = user32.func("int __stdcall CloseDesktop(void *)");
const GetUserObjectInformationW = user32.func("int __stdcall GetUserObjectInformationW(void *, int, void *, uint32_t, _Out_ uint32_t *)");
const GetDC = user32.func("void *__stdcall GetDC(void *)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *, void *)");
const GetForegroundWindow = user32.func("void *__stdcall GetForegroundWindow()");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *, void *, int)");
const GetWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *, _Out_ uint32_t *)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int, int)");
const SendInput = user32.func("uint32_t __stdcall SendInput(uint32_t, INPUT *, int)");
const MapVirtualKeyW = user32.func("uint32_t __stdcall MapVirtualKeyW(uint32_t, uint32_t)");
const GetAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int)");

const CreateCompatibleDC = gdi32.func("void *__stdcall CreateCompatibleDC(void *)");
const CreateCompatibleBitmap = gdi32.func("void *__stdcall CreateCompatibleBitmap(void *, int, int)");
const SelectObject = gdi32.func("void *__stdcall SelectObject(void *, void *)");
const SetStretchBltMode = gdi32.func("int __stdcall SetStretchBltMode(void *, int)");
const SetBrushOrgEx = gdi32.func("int __stdcall SetBrushOrgEx(void *, int, int, void *)");
const StretchBlt = gdi32.func("int __stdcall StretchBlt(void *, int, int, int, int, void *, int, int, int, int, uint32_t)");
const GetDIBits = gdi32.func("int __stdcall GetDIBits(void *, void *, uint32_t, uint32_t, void *, BITMAPINFOHEADER *, uint32_t)");
const DeleteObject = gdi32.func("int __stdcall DeleteObject(void *)");
const DeleteDC = gdi32.func("int __stdcall DeleteDC(void *)");

const OpenProcess = kernel32.func("void *__stdcall OpenProcess(uint32_t, int, uint32_t)");
const QueryFullProcessImageNameW = kernel32.func("int __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)");
const CloseHandle = kernel32.func("int __stdcall CloseHandle(void *)");
const CreateMutexW = kernel32.func("void *__stdcall CreateMutexW(void *, int, str16)");
const WaitForSingleObject = kernel32.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)");
const ReleaseMutex = kernel32.func("int __stdcall ReleaseMutex(void *)");

const MUTEX_NAME = "Local\\tau-computer-lease";
const MUTEX_WAIT_MS = 5000;

/** 在命名互斥量里跑 fn（给租约文件的读写用，几毫秒）。等 5 秒拿不到就抛 Fail。 */
export function withLeaseMutex<T>(fn: () => T): T {
  const h = CreateMutexW(null, 0, MUTEX_NAME);
  if (h === null) throw new Fail("建不了桌面租约的互斥量。");
  try {
    const r = WaitForSingleObject(h, MUTEX_WAIT_MS);
    // 0 是拿到；0x80 是前一个持有者崩了，互斥量仍归我们。
    if (r !== 0 && r !== 0x80) throw new Fail("桌面租约正被占用，稍后再试。");
    try {
      return fn();
    } finally {
      ReleaseMutex(h);
    }
  } finally {
    CloseHandle(h);
  }
}

const PER_MONITOR_AWARE_V2 = -4;
const LOCKED = "屏幕锁着、停在 UAC 提示上，或者会话断开了：拿不到输入桌面，截不了图也点不了。";

/** 设成每显示器 DPI 感知，坐标和截图都按物理像素。必须在任何 GetDC、GetSystemMetrics 之前调用。 */
export function initDpi(): void {
  if (SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) === 0) SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
}

/** 主屏的物理像素尺寸，原点是 (0, 0)。 */
export function screenSize(): Size {
  const w = GetSystemMetrics(0);
  const h = GetSystemMetrics(1);
  if (w <= 0 || h <= 0) throw new Fail("读不到主屏的尺寸。");
  return { w, h };
}

/** 输入桌面不是 Default（锁屏、UAC 提示、会话断开）时，返回原因；正常返回 null。那时截不了图也点不了。 */
export function desktopProblem(): string | null {
  const h = OpenInputDesktop(0, 0, 0x0001);
  if (h === null) return LOCKED;
  try {
    const buf = Buffer.alloc(512);
    if (GetUserObjectInformationW(h, 2, buf, buf.length, [0]) === 0) return `读不到输入桌面的名字。${LOCKED}`;
    const name = buf.toString("utf16le").split("\0")[0] ?? "";
    return name.toLowerCase() === "default" ? null : `输入桌面是“${name}”，不是 Default。${LOCKED}`;
  } finally {
    CloseDesktop(h);
  }
}

export function checkDesktop(): void {
  const p = desktopProblem();
  if (p !== null) throw new Fail(p);
}

/** 把屏幕上的 `src` 缩放到 `dst` 大小，返回自上而下的 32 位 BGRA。 */
export function capture(src: Rect, dst: Size): Buffer {
  const screen = GetDC(null);
  if (screen === null) throw new Fail("截图失败：GetDC 没拿到屏幕。");
  let mem: unknown = null;
  let bmp: unknown = null;
  let old: unknown = null;
  try {
    mem = CreateCompatibleDC(screen);
    if (mem === null) throw new Fail("截图失败：CreateCompatibleDC 失败。");
    bmp = CreateCompatibleBitmap(screen, dst.w, dst.h);
    if (bmp === null) throw new Fail("截图失败：CreateCompatibleBitmap 失败。");
    old = SelectObject(mem, bmp);
    if (old === null) throw new Fail("截图失败：SelectObject 失败。");
    SetStretchBltMode(mem, 4); // HALFTONE：缩小时取平均，不丢细线
    SetBrushOrgEx(mem, 0, 0, null);
    // SRCCOPY | CAPTUREBLT：连分层窗口一起拿。
    if (StretchBlt(mem, 0, 0, dst.w, dst.h, screen, src.x, src.y, src.w, src.h, 0x00cc0020 | 0x40000000) === 0) throw new Fail("截图失败：StretchBlt 失败。");
    SelectObject(mem, old); // GetDIBits 要求位图不在任何 DC 里
    old = null;
    const bits = Buffer.alloc(dst.w * dst.h * 4);
    const info = { biSize: 40, biWidth: dst.w, biHeight: -dst.h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    const lines = GetDIBits(screen, bmp, 0, dst.h, bits, info, 0);
    if (lines !== dst.h) throw new Fail(`截图失败：GetDIBits 只取到 ${lines} 行，要 ${dst.h} 行。`);
    return bits;
  } finally {
    if (old !== null && mem !== null) SelectObject(mem, old);
    if (bmp !== null) DeleteObject(bmp);
    if (mem !== null) DeleteDC(mem);
    ReleaseDC(null, screen);
  }
}

/** 前台窗口的标题和程序文件名；哪个拿不到就是空串。 */
export function foreground(): { title: string; exe: string } {
  const hwnd = GetForegroundWindow();
  if (hwnd === null) return { title: "", exe: "" };
  const tb = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, tb, 512);
  const title = n > 0 ? tb.toString("utf16le", 0, n * 2) : "";
  let exe = "";
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (pid[0]! > 0) {
    const h = OpenProcess(0x1000, 0, pid[0]!); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h !== null) {
      try {
        const nb = Buffer.alloc(2048);
        const size = [1024];
        if (QueryFullProcessImageNameW(h, 0, nb, size) !== 0) exe = (nb.toString("utf16le", 0, size[0]! * 2).split("\\").pop() ?? "").trim();
      } finally {
        CloseHandle(h);
      }
    }
  }
  return { title, exe };
}

export function setCursor(p: Point): void {
  if (SetCursorPos(p.x, p.y) === 0) throw new Fail(`移不动鼠标到 (${p.x}, ${p.y})。多半是屏幕锁着，或者目标窗口是管理员权限。`);
}

export function toInput(e: InputEvent): object {
  if (e.kind === "mouse") return { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: e.data, dwFlags: e.flags, time: 0, dwExtraInfo: 0 } } };
  const KEYUP = 0x2;
  if (e.kind === "unit") return { type: 1, u: { ki: { wVk: 0, wScan: e.unit, dwFlags: 0x4 | (e.up ? KEYUP : 0), time: 0, dwExtraInfo: 0 } } }; // KEYEVENTF_UNICODE
  const flags = (e.ext ? 0x1 : 0) | (e.up ? KEYUP : 0); // KEYEVENTF_EXTENDEDKEY
  return { type: 1, u: { ki: { wVk: e.vk, wScan: MapVirtualKeyW(e.vk, 0), dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

/** 把事件按 INPUT 的布局编进缓冲区，每个 40 字节。不发送，给测试查字节用。 */
export function encodeInputs(events: InputEvent[]): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE * events.length);
  events.forEach((e, i) => koffi.encode(buf, i * INPUT_SIZE, INPUT, toInput(e)));
  return buf;
}

/** 一次 SendInput 发完。发出的比要发的少，多半是 UIPI 挡了：目标窗口是管理员权限。 */
export function send(events: InputEvent[]): void {
  if (events.length === 0) return;
  const n = SendInput(events.length, events.map(toInput), INPUT_SIZE);
  if (n < events.length) throw new Fail(`输入只发出了 ${n}/${events.length} 个事件。多半是目标窗口以管理员权限运行，输入被系统挡了；也可能屏幕锁着。`);
}

/** 放开卡住的键：上一次调用可能在拖动或按组合键途中被结束。 */
export function releaseStuck(): void {
  send(stuckEvents((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0));
}
