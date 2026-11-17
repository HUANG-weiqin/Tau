# 在桌面上放一个 “tau” 快捷方式：点它运行 start.ps1，起服务和桥（已经在运行的不重复起），然后打开页面。
# 图标画在 ~/.tau/extras/gui/tau.ico：黄底黑字的 τ，和界面左上角的标志一样。仓库挪了位置，重新运行这个脚本。
# 快捷方式经 conhost --headless 起 PowerShell：不闪终端窗口（默认终端是 Windows Terminal 时，-WindowStyle Hidden 也会闪）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dir = Join-Path $HOME '.tau\extras\gui'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ico = Join-Path $dir 'tau.ico'

# 一张尺寸画成 PNG 的字节。
function Draw-Png([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0xFF, 0xEF, 0x00))
  $font = New-Object System.Drawing.Font 'Segoe UI Black', ([single]($size * 0.98)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 0x0C, 0x0D, 0x0C))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ([single](-$size * 0.12)), $size, $size
  $g.DrawString([string][char]0x03C4, $font, $brush, $rect, $fmt)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

# ICO：文件头、每张一项目录、再接各张 PNG（Windows Vista 起认 PNG 压缩的图标）。
$sizes = 16, 24, 32, 48, 64, 256
$pngs = foreach ($s in $sizes) { ,(Draw-Png $s) }
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes($ico, $out.ToArray())

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'tau.lnk'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$start = Join-Path $repo 'extras\gui\start.ps1'
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
$sc.Arguments = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$start`" -Popup"
$sc.WorkingDirectory = $repo
$sc.IconLocation = "$ico,0"
$sc.Description = '起 tau 的服务和界面，打开页面'
$sc.Save()
"快捷方式：$lnk"
"图标：$ico"
