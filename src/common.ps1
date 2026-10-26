# CLIP STUDIO 素材库自动翻译 —— 公共函数（被其他脚本 dot-source 引入）
# 作用：找一个可用的 node.exe，避免把某个人的绝对路径写死

function Find-NodeExe {
    # 1) PATH 里的 node
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    # 2) 常见安装位置
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\npm\node.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }

    # 3) nvm-windows
    $nvm = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvm) {
        $hit = Get-ChildItem -LiteralPath $nvm -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }

    throw '找不到 node.exe。请先安装 Node.js（https://nodejs.org），或把 node.exe 加入 PATH。'
}

function Get-PluginRoot {
    return Split-Path -Parent $PSScriptRoot
}
