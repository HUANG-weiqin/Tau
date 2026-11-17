# 干净的环境和起停的小件，start.ps1 和 restart.ps1 共用（点号引入）。
# 干净的环境 = 和新开一个终端一样：注册表里的机器和用户变量、Volatile Environment，加系统固定的几个。
# 调用方（例如某个 Agent 的 bash）的变量和令牌不会带给服务，也就不会进 Agent 的 bash。
$script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:Port = 4317
$script:LogDir = Join-Path $HOME '.tau\extras\gui'
New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
$script:Node = (Get-Command node).Source

function New-CleanEnv {
  $clean = @{}
  $std = 'ALLUSERSPROFILE','APPDATA','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432','COMPUTERNAME','COMSPEC','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','LOGONSERVER','NUMBER_OF_PROCESSORS','OS','PATHEXT','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','PUBLIC','SYSTEMDRIVE','SYSTEMROOT','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','USERNAME','USERPROFILE','WINDIR','DRIVERDATA','SESSIONNAME'
  foreach ($s in $std) { $v = [Environment]::GetEnvironmentVariable($s, 'Process'); if ($null -ne $v) { $clean[$s] = $v } }
  foreach ($scope in 'Machine', 'User') {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($k in $vars.Keys) { if ($k -ine 'Path') { $clean[$k] = [Environment]::ExpandEnvironmentVariables([string]$vars[$k]) } }
  }
  $vol = Get-Item 'HKCU:\Volatile Environment' -ErrorAction SilentlyContinue
  if ($vol) { foreach ($k in $vol.GetValueNames()) { if ($k -ne '') { $clean[$k] = [string]$vol.GetValue($k) } } }
  $mp = [Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('Path', 'Machine'))
  $up = [Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('Path', 'User'))
  $clean['Path'] = ($mp.TrimEnd(';') + ';' + $up).TrimEnd(';')
  return $clean
}

# 用干净的环境起 node 脚本，隐藏窗口；stdout 和 stderr 合并追加到 ~/.tau/extras/gui/<name>.log。cmd 只负责重定向。
function Start-Clean($name, $script, $extra) {
  $log = Join-Path $script:LogDir "$name.log"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $psi.Arguments = "/d /c `"`"$($script:Node)`" `"$script`" $extra >>`"$log`" 2>&1`""
  $psi.WorkingDirectory = $script:Repo
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.Environment.Clear()
  $clean = New-CleanEnv
  foreach ($k in $clean.Keys) { $psi.Environment[$k] = $clean[$k] }
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Test-Pipe { Test-Path '\\.\pipe\tau' }
function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $script:Port); $true } catch { $false } finally { $c.Dispose() }
}
# 等 $test 的结果变成 $want，最多 15 秒。
function Wait-For($test, $want, $what) {
  for ($i = 0; $i -lt 150; $i++) { if ((& $test) -eq $want) { return }; Start-Sleep -Milliseconds 100 }
  throw "等了 15 秒，$what。看 $($script:LogDir) 里的日志。"
}
