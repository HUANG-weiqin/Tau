# 起服务和桥（已经在运行的不重复起），然后打开页面。不做开机自启。
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$port = 4317
$logDir = Join-Path $HOME '.tau\extras\gui'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node).Source

function Test-Pipe { Test-Path '\\.\pipe\tau' }
function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); $true } catch { $false } finally { $c.Dispose() }
}
# stdout 和 stderr 合并写进同一个日志。cmd 只负责重定向。
function Start-Hidden($name, $script, $extra) {
  $log = Join-Path $logDir "$name.log"
  $cmd = "/d /c `"`"$node`" `"$script`" $extra >>`"$log`" 2>&1`""
  Start-Process -FilePath cmd.exe -ArgumentList $cmd -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
}
function Wait-Until($test, $what) {
  for ($i = 0; $i -lt 100; $i++) {
    if (& $test) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "等了 10 秒，$what 还没起来。看 $logDir 里的日志。"
}

if (-not (Test-Pipe)) { Start-Hidden 'serve' "$repo\src\main.ts" 'serve' }
if (-not (Test-Port)) { Start-Hidden 'bridge' "$repo\extras\gui\bridge\main.ts" "--port $port" }
Wait-Until { Test-Pipe } '服务'
Wait-Until { Test-Port } '桥'
Start-Process "http://127.0.0.1:$port/"
