#!/usr/bin/env bash
# ============================================================
# O-yuan (启原) 一键安装脚本 - Linux / macOS
# 用法:  bash install.sh [--skip-build] [--port 3088]
# ============================================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKIP_BUILD=0
PORT=3088

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    *) ;;
  esac
done

echo ""
echo "========================================================"
echo "  O-yuan · 启原  通用智能体  一键安装"
echo "========================================================"
echo "  项目目录: $PROJECT_DIR"
echo ""

echo "[1/6] 检测 Node.js ..."
if ! command -v node >/dev/null 2>&1; then
  echo "  ❌ 未找到 Node.js，请先安装 Node.js >= 16"
  exit 1
fi
echo "  ✅ Node.js $(node --version)"

echo "[2/6] 检测 Python（GUI 自动化可选）..."
if command -v python3 >/dev/null 2>&1; then
  echo "  ✅ Python $(python3 --version 2>&1)"
  echo "     提示: GUI 能力需 pip install pyautogui pillow"
else
  echo "  ⚠️ 未找到 Python，GUI 自动化不可用（其余功能正常）"
fi

echo "[3/6] 安装 npm 依赖..."
cd "$PROJECT_DIR"
npm install --no-audit --no-fund || { echo "  ❌ npm install 失败"; exit 1; }
npm link --no-audit --no-fund 2>/dev/null || true
echo "  ✅ 依赖安装完成（已注册全局命令 oyuan）"

echo "[4/6] 编译 C++ 原生扩展..."
if [ "$SKIP_BUILD" = "1" ]; then
  echo "  ⏭️ 已跳过编译（--skip-build），使用 JS 降级实现"
else
  if npm run build 2>/dev/null; then
    echo "  ✅ C++ 扩展编译成功（原生加速启用）"
  else
    echo "  ⚠️ C++ 编译失败，将使用纯 JS 实现（功能完整）"
    echo "     Linux:  sudo apt install build-essential python3"
    echo "     macOS:  xcode-select --install"
  fi
fi

echo "[5/6] 初始化配置..."
CFG_FILE="$PROJECT_DIR/config/config.json"
if [ ! -f "$CFG_FILE" ]; then
  echo "  ✅ 配置将首次启动时自动生成"
else
  echo "  ✅ 检测到已有配置"
fi

echo "[6/6] 完成！"
echo ""
echo "  启动方式:  oyuan start（推荐）或 npm start"
echo "  查看状态:  oyuan status"
echo "  查看配置:  oyuan config"
echo "  访问地址:  http://127.0.0.1:$PORT"
echo ""
echo "安装完成。如需立即启动，请运行: npm start"