# 清空翻译缓存（改了词库、或想让某些词重新翻译时用）
# 清完后刷新素材页即可重新翻译
#
# 用法：powershell -ExecutionPolicy Bypass -File 清空缓存.ps1

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root 'src\common.ps1')

$Node = Find-NodeExe
& $Node (Join-Path $Root 'src\clear-cache.js')
