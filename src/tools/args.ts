// 弱模型填参数常出错。库内和库外工具共用这一处修正（见 .knowledge/kb-tools.md「参数从哪来」）。
type Schema = { properties?: Record<string, { type?: string }>; required?: readonly string[] };

function parseContainer(v: string, t: "array" | "object"): unknown {
  try {
    const p: unknown = JSON.parse(v);
    return (t === "array" ? Array.isArray(p) : typeof p === "object" && p !== null && !Array.isArray(p)) ? p : v;
  } catch {
    return v;
  }
}

/** 可选参数的 null 当作没填，必填的 null 是错误；再按 schema 的类型转标量（`"3"` 转 3，`"true"` 转布尔，数字和布尔转字符串，字符串化的 JSON 数组/对象）。返回修好的参数，或者错误文字。 */
export function fixArgs(parameters: object, args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
  const schema = parameters as Schema;
  const required = schema.required ?? [];
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) {
    if (v === null) {
      if (required.includes(k)) return { error: `参数 ${k} 是 null，必须给出一个值。` };
      continue;
    }
    const t = schema.properties?.[k]?.type;
    out.set(k,
      t === "string" && (typeof v === "number" || typeof v === "boolean") ? String(v)
      : t === "integer" && typeof v === "string" && /^-?\d+$/.test(v) ? Number(v)
      : t === "boolean" && (v === "true" || v === "false") ? v === "true"
      : (t === "array" || t === "object") && typeof v === "string" ? parseContainer(v, t)
      : v);
  }
  return { args: Object.fromEntries(out) };
}
