# ============================================================
# O-yuan (启原) 一键安装脚本
# 适用：Windows / Linux / macOS
# 用法（Windows PowerShell）:
#   .\install.ps1
# 用法（Linux/macOS）:
#   chmod +x install.sh && ./install.sh   （或直接 bash install.sh）
# 功能：检测环境 -> 安装依赖 -> (可选)编译C++扩展 -> 初始化配置 -> 启动
# ============================================================

[CmdletBinding()]
param(
    [switch]$SkipBuild,      # 跳过 C++ 扩展编译
    [switch]$StartNow,       # 安装后立即启动
    [string]$Port = "3088"   # 默认端口
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ProjectDir)) { $ProjectDir = (Get-Location).Path }

Write-Host ""
Write-Host "========================================================"
Write-Host "  O-yuan · 启原  通用智能体  一键安装"
Write-Host "========================================================"
Write-Host "  项目目录: $ProjectDir"
Write-Host ""

# ---- 1. 检测 Node.js ----
Write-Host "[1/6] 检测 Node.js ..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  ❌ 未找到 Node.js。请先安装 Node.js >= 16：" -ForegroundColor Red
    Write-Host "     https://nodejs.org/"
    exit 1
}
$nodeVer = & node --version
Write-Host "  ✅ Node.js $nodeVer"

# ---- 2. 检测 Python（GUI 能力可选） ----
Write-Host "[2/6] 检测 Python（GUI 自动化可选）..."
$py = Get-Command python -ErrorAction SilentlyContinue
$havePy = $false
if ($py) { $havePy = $true; $pyVer = & python --version 2>&1 }
if ($havePy) {
    Write-Host "  ✅ Python $pyVer"
} else {
    Write-Host "  ⚠️ 未找到 Python。GUI 自动化（截图/鼠标/键盘）不可用，其余功能正常。"
    Write-Host "     如需 GUI 能力，请安装 Python 3 + pip install pyautogui pillow"
}

# ---- 3. 安装 npm 依赖 ----
Write-Host "[3/6] 安装 npm 依赖..."
Push-Location $ProjectDir
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    # 全局注册 oyuan 命令
    npm link --no-audit --no-fund 2>$null
    Write-Host "  ✅ 依赖安装完成（已注册全局命令 oyuan）"
} catch {
    Write-Host "  ❌ npm install 失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally { Pop-Location }

# ---- 4. 编译 C++ 扩展（可选） ----
Write-Host "[4/6] 编译 C++ 原生扩展..."
Push-Location $ProjectDir
try {
    if ($SkipBuild) {
        Write-Host "  ⏭️ 已跳过编译（--SkipBuild），使用 JS 降级实现"
    } else {
        npm run build
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ C++ 扩展编译成功（原生加速启用）"
        } else {
            Write-Host "  ⚠️ C++ 编译失败（可能缺少编译工具链）。应用将使用纯 JS 实现，功能完整。"
            Write-Host "     Windows: 需安装 Visual Studio Build Tools"
            Write-Host "     Linux:   sudo apt install build-essential python3"
            Write-Host "     macOS:   xcode-select --install"
        }
    }
} catch {
    Write-Host "  ⚠️ C++ 编译跳过: $($_.Exception.Message)"
} finally { Pop-Location }

# ---- 5. 初始化配置 ----
Write-Host "[5/6] 初始化配置..."
$cfgPath = Join-Path $ProjectDir "configconfig.json"
if (-not (Test-Path $cfgPath)) {
    Write-Host "  ✅ 配置将首次启动时自动生成"
} else {
    Write-Host "  ✅ 检测到已有配置"
}

# 若用户传入端口，写入配置
if ($Port -ne "3088") {
    try {
        $cfg = Get-Content $cfgPath -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($cfg.server) { $cfg.server.port = [int]$Port }
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding UTF8
        Write-Host "  已设置端口: $Port"
    } catch {}
}

# ---- 6. 启动 ----
Write-Host "[6/6] 完成！"
Write-Host ""
Write-Host "  启动方式："
Write-Host "    oyuan start          # 全局命令（推荐）"
Write-Host "    oyuan status         # 查看状态"
Write-Host "    oyuan config         # 查看配置"
Write-Host "    或 npm start"
Write-Host "  访问地址："
Write-Host "    本机: http://127.0.0.1:$Port"
Write-Host ""

if ($StartNow) {
    Write-Host "正在启动 O-yuan ..."
    Push-Location $ProjectDir
    & node src/js/server.js
    Pop-Location
} else {
    Write-Host "安装完成。如需立即启动，请运行：npm start" -ForegroundColor Green
}
