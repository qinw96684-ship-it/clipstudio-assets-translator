# 立即对当前已打开的素材页翻译一次（不想等守护进程时用）
#
# 用法：powershell -ExecutionPolicy Bypass -File 翻译一次.ps1

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root 'src\common.ps1')

$Node = Find-NodeExe
& $Node (Join-Path $Root 'src\daemon.js') --once --verbose
