// 选文件夹：经 PowerShell 弹出系统对话框。取消回 null。
import { execFile } from "node:child_process";

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$owner.Dispose()
`;

export type PickFolder = () => Promise<string | null>;

export const pickFolder: PickFolder = () =>
  new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", SCRIPT], { encoding: "utf8", timeout: 10 * 60_000, windowsHide: false }, (err, stdout) => {
      if (err) return reject(err);
      const p = stdout.replace(/^﻿/, "").trim();
      resolve(p === "" ? null : p);
    });
  });
