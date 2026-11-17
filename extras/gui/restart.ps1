# 重启服务、桥，或者两个都重启，都用干净的环境（见 cleanenv.ps1）。
#   restart.ps1 -Service        只重启服务（在跑的进程会被中断，工具调用报“被中断”，不自动重做）
#   restart.ps1 -Bridge         只重启桥（页面靠重连回来）
#   restart.ps1                 两个都重启
# 界面的“重启”按钮也是跑这个脚本，带 -BridgePid（桥自己的 PID）和 -BridgeArgs（桥原来的命令行参数）。
param(
  [switch]$Service,
  [switch]$Bridge,
  [int]$BridgePid = 0,
  [string]$BridgeArgs = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cleanenv.ps1')
if (-not $Service -and -not $Bridge) { $Service = $true; $Bridge = $true }

# 按命令行找 node 进程。cmd 只是重定向的外壳，不算。
function Find-Node($pattern) {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern })
}
function Stop-Node($procs) { foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }

if ($Service) {
  Stop-Node (Find-Node 'src[\\/]main\.ts"?\s+serve\s*$')
  Wait-For { Test-Pipe } $false '旧服务的管道还在'
  Start-Clean 'serve' "$Repo\src\main.ts" 'serve'
  Wait-For { Test-Pipe } $true '新服务没起来，看 serve.log'
  'service up'
}
# 桥放在最后：界面是经桥发来这条重启的，桥一停，这个脚本就是最后一个还在跑的。
if ($Bridge) {
  $extra = if ($BridgeArgs -ne '') { $BridgeArgs } else { "--port $Port" }
  if ($BridgePid -gt 0) { Stop-Process -Id $BridgePid -Force -ErrorAction SilentlyContinue }
  else { Stop-Node (Find-Node 'gui[\\/]bridge[\\/]main\.ts') }
  Wait-For { Test-Port } $false '旧桥的端口还占着'
  Start-Clean 'bridge' "$Repo\extras\gui\bridge\main.ts" $extra
  Wait-For { Test-Port } $true '新桥没起来，看 bridge.log'
  'bridge up'
}
