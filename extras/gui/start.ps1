# 起服务和桥（已经在运行的不重复起），然后打开页面。不做开机自启。
# 服务和桥都用干净的环境起（见 cleanenv.ps1），从哪里运行这个脚本都一样。
# -Popup：出错时弹一个对话框。桌面快捷方式带它：那里没有窗口，不弹就什么都看不到（见 shortcut.ps1）。
param([switch]$Popup)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'cleanenv.ps1')
  if (-not (Test-Pipe)) { Start-Clean 'serve' "$Repo\src\main.ts" 'serve' }
  if (-not (Test-Port)) { Start-Clean 'bridge' "$Repo\extras\gui\bridge\main.ts" "--port $Port" }
  Wait-For { Test-Pipe } $true '服务还没起来'
  Wait-For { Test-Port } $true '桥还没起来'
  Start-Process "http://127.0.0.1:$Port/"
} catch {
  if ($Popup) { (New-Object -ComObject WScript.Shell).Popup("tau 没起来：$($_.Exception.Message)", 0, 'tau', 16) | Out-Null }
  throw
}
