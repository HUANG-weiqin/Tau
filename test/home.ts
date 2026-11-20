// 副作用导入：把 home 指到临时目录。bash 工具的输出文件写在 ~/.tau/extras/shell（D90），测试不碰真的。
// 子进程（kill 测试的服务）继承父进程的环境，已经指过就不再建。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (!/tau-test-home-/.test(process.env.USERPROFILE ?? "")) {
  const home = mkdtempSync(path.join(os.tmpdir(), "tau-test-home-"));
  process.env.USERPROFILE = process.env.HOME = home;
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // 还有后台命令占着：留在临时目录里。
    }
  });
}
