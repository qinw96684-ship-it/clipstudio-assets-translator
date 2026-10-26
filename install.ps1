# CLIP STUDIO 素材库自动翻译 —— 安装脚本
#
# 作用：
#   1) 给 CLIP STUDIO 的内置浏览器（WebView2）打开本地调试端口 9222
#      （CLIP STUDIO 以管理员权限运行，只有机器级策略会被接受）
#   2) 建立计划任务，登录后自动在后台运行翻译守护进程
#
# 用法：右键「使用 PowerShell 运行」，或在管理员 PowerShell 里执行：
#       powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src    = Join-Path $Root 'src'
$Daemon = Join-Path $Src 'daemon.js'

. (Join-Path $Src 'common.ps1')

Write-Host '=== CLIP STUDIO 素材库自动翻译 · 安装 ===' -ForegroundColor Cyan

$Node = Find-NodeExe
Write-Host "Node: $Node"
Write-Host "插件: $Src"

if (-not (Test-Path -LiteralPath $Daemon)) { throw "找不到 daemon.js：$Daemon" }

# 确认有管理员权限（写 HKLM 需要）
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限才能写入 WebView2 策略。' -ForegroundColor Yellow
    Write-Host '请右键此脚本 →「使用 PowerShell 运行」，或从管理员 PowerShell 重新执行。' -ForegroundColor Yellow
    throw '缺少管理员权限'
}

# ---------- 1. WebView2 调试端口策略 ----------
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name 'CLIPStudio.exe' `
  -Value '--remote-debugging-port=9222' -PropertyType String -Force | Out-Null
Write-Host "[1/3] 已写入 WebView2 策略：$key" -ForegroundColor Green

# ---------- 2. 开机自启守护进程 ----------
$taskName = 'CLIPStudio_翻译守护'
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Daemon`"" -WorkingDirectory $Src

# 双触发器：
#   1) 登录时启动
#   2) 每 10 分钟检查一次 —— 进程若被意外结束（崩溃/被杀），能在 10 分钟内自愈
#      任务设了 MultipleInstances=IgnoreNew，所以已在运行时不会重复启动
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action `
  -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings `
  -RunLevel Highest -Force | Out-Null
Write-Host "[2/3] 已建立计划任务：$taskName（登录启动 + 每 10 分钟自愈检查）" -ForegroundColor Green

# ---------- 3. 立即启动 ----------
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Write-Host "[3/3] 守护进程已启动" -ForegroundColor Green

Write-Host ''
Write-Host '安装完成！' -ForegroundColor Cyan
Write-Host '  · 重启 CLIP STUDIO 后，打开「素材库」页面即自动显示目标语言'
Write-Host '  · 页面右下角有「自动翻译」小按钮，可切换语言 / 切回原文 / 清缓存'
Write-Host ''
Write-Host '  切换语言：编辑 config.json 里的 targetLanguage' -ForegroundColor Yellow
Write-Host '    可选：zh-CN（简体中文）/ id（印尼语）/ pt（葡语）/ th（泰语）'
Write-Host '    保存后约 2 秒自动生效，无需重启'
Write-Host ''
Write-Host '  卸载：运行 uninstall.ps1'
