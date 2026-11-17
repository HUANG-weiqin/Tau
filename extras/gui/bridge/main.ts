// 桥的入口：node extras/gui/bridge/main.ts [--port N] [--home DIR] [--host NAME]...
import { parseArgs } from "node:util";
import { createBridge } from "./server.ts";

const { values } = parseArgs({ options: { port: { type: "string" }, home: { type: "string" }, host: { type: "string", multiple: true } } });
const port = values.port === undefined ? 4317 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`端口不合法：${values.port}`);
  process.exit(2);
}
const bridge = await createBridge({ port, ...(values.home === undefined ? {} : { home: values.home }), ...(values.host === undefined ? {} : { hosts: values.host }) });
console.log(`桥已启动：http://127.0.0.1:${bridge.port}/`);
