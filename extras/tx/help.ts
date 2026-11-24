// tx 的用法：要能直接教会一个外部 Agent（Codex、Claude Code 里的模型，或者任何只有 shell 的 harness）。
// 文档和 main.ts 的路径由 tx 自己所在的位置算出，外部 Agent 的当前目录不在仓库里也找得到。
import path from "node:path";

export function helpText(root: string): string {
  const fwd = root.replace(/\\/g, "/");
  const main = path.join(root, "extras", "tx", "main.ts");
  return `tx：把 tau 当子 Agent 池用的命令行。前提：tau 服务在运行（没有就先 tau serve）。
选项都写在位置参数前面；写在后面是用法错误。进程 ID 只许小写，大写的会转成小写并说一声。
消息和任务写在命令行上（其余参数用一个空格连接），或者写 - 从标准输入读（UTF-8，去掉开头的 BOM 和末尾的换行）。

命令
  tx presets                                  列出预设：ID 和一句说明
  tx start [--id X] [--workdir D] [--image P]... <预设> <任务|->
                                              建进程，打印进程 ID，不等这一轮结束
  tx post [--image P]... [--handoff] <进程> <消息|->
                                              续聊：寄一封信，收到回执就返回；之后 tx wait 等的是新一轮
  tx wait [--any] [--timeout 秒] <进程>...    等结束（默认等全部，默认 100 秒；--any 是有一个结束就返回）
                                              每个进程一段：已结束的写 ID、预设、结束原因和最终回复，没结束的只写状态
  tx result <进程>                            打印当前段的最终回复
  tx ps [<进程>...]                           每个进程一行：阶段、上下文、段、运行多久、父进程、模型、排队数、后台命令数、在跑的子进程数
  tx history [--segment n] [--last n] <进程>  看历史（默认最后 20 条）
  tx stop <进程>...                           停止
  tx rm <进程>...                             删除（只能删空闲、没人引用的进程）
  tx fork [--before n] [--preset p] [--id X] <进程>
                                              复制进程，打印新进程的 ID（--before 是段内序号；--preset 是换角色）
  tx req [--timeout 秒] <JSON 请求|->         原样发任何线协议请求，每行回复原样写成一行 JSON

什么叫“结束”
  进程这一轮停了（idle，带结束原因），而且没有后台命令在跑，也没有子进程在跑，才算结束。
  它转到后台的命令、它派出去的子进程，跑完都会唤醒它再开一轮，那一轮才是真结果。
  所以 tx wait 对“停了但还有后台命令或子进程”的进程只写状态（还有几个后台命令、几个子进程），继续等就行。
  tx result 在这种时候照样打印当前回复，但标准错误写“回复可能还会变”，退出码 4。

退出码
  0 成功   1 服务回了错误；result 的结束原因不是 done；wait 的 ID 不存在
  2 用法错误或连不上服务（请求没发出）
  3 连接断了，结果未知（start 和 fork 会把 ID 写到标准错误：用 tx ps <ID> 查，不要盲目重发）
  4 超时，或者还没结束（不是错误：再 tx wait，或者先做别的）
  tx wait 等到了就是 0，不管各进程怎么结束的，原因写在输出里。

--timeout：外部 harness 的单次命令有超时，--timeout 要设得比它短。
  Claude Code 的默认是 2 分钟，用 100；不清楚自己的 harness 超时多久，就用 10，返回 4 再等。

例子（照抄就能跑，Git Bash）：派三个子 Agent，等全部，取结果，删掉
tx presets
a=$(tx start worker "审 src/a.ts，列出问题")
b=$(tx start --workdir /c/proj worker "审 src/b.ts，列出问题")
c=$(tx start worker - <<'EOF'
任务很长、有多行时，用 heredoc 加 -。
第二行。
EOF
)
tx wait $a $b $c
tx post $a "再看一下 src/c.ts"
tx wait $a
tx rm $a $b $c
（tx wait 返回 4 就再等一次。）

路径（--workdir、--image）：认 C:\\x、C:/x、Git Bash 的 /c/x；相对路径按当前目录；别的以 / 开头的（/tmp）报错，先 cygpath -w。

PowerShell 和 cmd
  不要经 tx.cmd 传带 & | < > ^ % 或引号的正文：cmd.exe 会改坏它（& 把命令截断并执行后面的话，% 被展开，
  引号和 ^ 被吃掉，| 和 > 会当成管道和重定向）。请求照样发出，退出码却可能是错的，别因此重发。
  改用 node 直接调：
node "${main}" start worker "短正文，没有特殊字符"
  正文有特殊字符、引号或多行时，一律走标准输入 -。PowerShell 里用 here-string：
@'
带 "引号" 和 & | ^ % 的
多行正文
'@ | node "${main}" start worker -
  Windows PowerShell 5.1 给原生程序传参时，内嵌的双引号会坏，所以带引号的正文只能走 -。
  5.1 还要先设编码，否则管道里的中文变成问号，输出里的中文乱码：
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.Encoding]::UTF8
  上面的 tx 都可以换成 node "${main}"。

其余协议请求走 tx req，每种一个最短的例子（进程 ID、预设换成自己的）：
  tx req '{"op":"inspect","process":"ID"}'                    原样的进程记录；不带 process 是全部
  tx req '{"op":"check","preset":"worker"}'                   预设会读成什么快照，能不能启动
  tx req '{"op":"memory","ns":"worker"}'                      读记忆；不带 ns 列有记忆的 ns
  tx req '{"op":"memory_write","ops":[{"kind":"set","ns":"worker","key":"k","value":"v","expected":null}]}'
                                                              写记忆：expected 是读到的版本号，新键写 null
  tx req '{"op":"reconfigure","process":"ID","fields":{"model":"供应商/模型"}}'
                                                              改这个会话的配置；放弃待换的配置用 "revert":true
  tx req '{"op":"prune","process":"ID","before":2}'           删段号小于 2 的旧段
  tx req '{"op":"sweep"}'                                     清掉没人引用的图片
  tx req '{"op":"backup","path":"C:/x/tau.db"}'               备份整个库
  tx req '{"op":"blob","hash":"哈希"}'                        读一张图片（base64）
  tx req --timeout 10 '{"op":"watch","process":"ID"}'         订阅状态变化，到点截断（返回 4）
  请求的全部字段见 ${fwd}/.knowledge/kb-service.md（“线协议”一节）。PowerShell 里请求同样走 -：'{"op":"ps"}' | node "${main}" req -

文件
  预设：~/.tau/presets/<id>.md，文件名就是预设 ID。格式见 ${fwd}/docs/design/mvp.md（第 2 节“预设”）。直接写文件，下一次 tx start 就能用。
  工具定义：~/.tau/tools/<name>.json。格式见 ${fwd}/.knowledge/kb-tools.md（“工具定义”一节）。
  改预设文件不影响已有的进程：它们的配置在出生时定了，只能用 reconfigure 改。
`;
}
