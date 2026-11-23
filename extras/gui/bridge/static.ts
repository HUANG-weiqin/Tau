// 静态文件：只送固定目录里的文件，路径解析以后不许出目录。
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const VENDOR_PACKAGES = ["preact", "htm", "@fontsource-variable/archivo", "@fontsource-variable/jetbrains-mono", "@fontsource-variable/noto-sans-sc", "marked", "dompurify", "mermaid"];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 把 URL 里 base 之后的部分解析成 base 下的文件路径；不合法回 null。 */
export function resolveInside(base: string, rawRel: string): string | null {
  if (rawRel.includes("\\")) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(rawRel);
  } catch {
    return null;
  }
  if (rel === "" || /[\\\u0000:]/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return null;
  return full;
}

/** `urlPath` 是不含查询串的路径。回文件路径，或 null（404）。 */
export function routeStatic(urlPath: string, webDir: string, vendorDir: string): string | null {
  if (urlPath === "/") return path.join(webDir, "index.html");
  if (urlPath.startsWith("/web/")) return resolveInside(webDir, urlPath.slice(5));
  if (urlPath.startsWith("/vendor/")) {
    const rest = urlPath.slice(8);
    const pkg = VENDOR_PACKAGES.find((p) => rest.startsWith(`${p}/`));
    if (!pkg) return null;
    return resolveInside(path.join(vendorDir, pkg), rest.slice(pkg.length + 1));
  }
  return null;
}

export async function readStatic(file: string): Promise<Buffer | null> {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}
