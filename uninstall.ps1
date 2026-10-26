# CLIP STUDIO 素材库自动翻译 —— 卸载脚本
#
# 作用：删除 WebView2 调试端口策略 + 停止并删除计划任务
# 卸载后 CLIP STUDIO 完全恢复原状（翻译面板也不再出现）
#
# 用法：管理员 PowerShell 里执行
#       powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = 'Continue'

Write-Host '=== 卸载 CLIP STUDIO 素材库自动翻译 ===' -ForegroundColor Cyan

# ---------- 1. 停止并删除计划任务 ----------
$taskName = 'CLIPStudio_翻译守护'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# 结束可能残留的守护进程（只杀运行本插件 daemon.js 的那个）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'daemon\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host '[1/2] 已删除计划任务并停止守护进程' -ForegroundColor Green

# ---------- 2. 删除 WebView2 策略 ----------
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
Remove-ItemProperty -Path $key -Name 'CLIPStudio.exe' -ErrorAction SilentlyContinue

# 若该键已空则一并删除
$left = Get-Item $key -ErrorAction SilentlyContinue
if ($left -and $left.Property.Count -le 0) {
    Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '[2/2] 已删除 WebView2 策略' -ForegroundColor Green

Write-Host ''
Write-Host '卸载完成。重启 CLIP STUDIO 后素材库恢复原样。' -ForegroundColor Cyan
Write-Host '翻译缓存仍在浏览器本地存储里，不影响使用。'
