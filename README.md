# O-yuan (启原) v3.0

> Cross-platform universal intelligent Agent — self-developed architecture that reproduces and improves the core capabilities of mainstream industry Agents.
>
> 跨平台通用智能体 Agent — 自研架构，复现并完善业界主流 Agent 的核心能力。

## Introduction / 项目简介

O-yuan (启原) is a fully self-hosted universal intelligent Agent that adopts a hybrid architecture of **Node.js upper-layer scheduling + C++ native extensions (optional)**. The design goal is to provide tool calling, multi-model deliberation, GUI automation, persistent Shell, and other capabilities comparable to commercial Agents while maintaining minimal dependencies.

O-yuan（启原）是一个完全自托管的通用智能体 Agent，采用 **Node.js 上层调度 + C++ 原生扩展（可选）** 的混合架构。设计目标是在保持极简依赖的前提下，提供媲美商业 Agent 的工具调用、多模型合议、GUI 自动化、持久化 Shell 等能力。

**Core Philosophy / 核心哲学**: Security policies are determined by developers themselves. Configurations are stored in plain text, no sandbox enforcement, no password authentication — all security boundaries are left to users to build as needed.

**核心哲学**：安全策略由开发者自行决定。配置明文存储、无沙箱强制、无密码鉴权——所有安全边界交给使用者按需搭建。

## Core Features / 核心特性

### 🤖 Agent Loop (Native function calling / 原生 function calling)
- Native tool calling loop based on OpenAI standard `tool_calls`
- 基于 OpenAI 标准 `tool_calls` 的原生工具调用循环
- No hard step limit (default 50 steps, configurable)
- 无步数硬限制（默认 50 步，可配置）
- No tool result truncation, complete return
- 无工具结果截断，完整返回
- Support parallel calling of multiple tools in the same round
- 支持同一轮并行调用多个工具
- Streaming output (real-time token-by-token rendering)
- 流式输出（token 逐块实时渲染）

### 🔀 Multi-Model Deliberation Scheduling / 多模型合议调度
- Four modes: `fast` (quick return) / `equal` (equal voting) / `weighted` (weighted voting) / `deep` (deep secondary summary)
- 四种模式：`fast`（快速返回）/ `equal`（均等投票）/ `weighted`（加权投票）/ `deep`（深度二次汇总）
- Support designating a **primary model (coordinator)** responsible for summarizing results from multiple parties
- 支持指定**主模型（协调者）**，负责汇总多方结果
- Automatic model failure blacklist (automatically skipped after consecutive failures reach threshold)
- 模型故障自动黑名单（连续失败达阈值自动跳过）
- Thinking depth control (native temperature mapping / prompt_override reasoning constraints)
- 思考深度控制（native 温度映射 / prompt_override 推理约束）

### 🛠 28 Built-in Tools / 28 个内置工具

| Category / 分类 | Tools / 工具 |
|------|------|
| **Filesystem / 文件系统** | `list_dir`、`read_file`、`write_file`、`edit_file`、`search_files`、`glob` |
| **Shell** | `shell_exec` (persistent / 持久化)、`shell_status`、`shell_cd`、`shell_close`、`run_command` |
| **Code Execution / 代码运行** | `run_code` (Python / JavaScript isolated execution / 隔离执行) |
| **Network / 网络** | `web_fetch` (web page fetching, HTML auto-converted to plain text / 网页获取，HTML 自动转纯文本) |
| **Development / 开发** | `git` (status/log/diff/commit/branch/pull/push etc. / 等)、`todo` (task management / 任务管理) |
| **GUI Automation / GUI 自动化** | `gui_screenshot`、`gui_mouse`、`gui_keyboard`、`gui_screen`、`gui_screencrop` |
| **Agent** | `subagent` (sub-agent delegation, supports process isolation / 子代理委派，支持进程隔离) |
| **Others / 其他** | `kb_query` (knowledge base / 知识库)、`web_search`、`load_skill`、`workflow` |

### 🖥 GUI Automation / GUI 自动化
- Virtual mouse/keyboard/screenshot based on Python + pyautogui
- 基于 Python + pyautogui 的虚拟鼠标/键盘/截屏
- Support vision models to directly view images for operation
- 支持 vision 模型直接看图操作
- Automatic screenshot injection (auto-capture when screen-related intent is detected)
- 自动截图注入（检测到屏幕相关意图时自动截屏）

### 💾 Persistence & Local Storage / 持久化与本地存储
- Conversation history: `logs/sessions.json` (structured / 结构化) + `logs/conversations/*.txt` (human-readable plain text / 人类可读明文)
- 对话历史：`logs/sessions.json`（结构化）+ `logs/conversations/*.txt`（人类可读明文）
- Configuration: `config/config.json` (plain text JSON, includes API Key / 明文 JSON，含 API Key)
- 配置：`config/config.json`（明文 JSON，含 API Key）
- Knowledge base: `config/kb/` (local RAG / 本地 RAG)
- 知识库：`config/kb/`（本地 RAG）
- Character roles: `config/roles/`
- 角色人设：`config/roles/`
- Skill packs: `config/skills/`
- 技能包：`config/skills/`

### 🎨 Frontend Interface / 前端界面
- Dark / light theme toggle
- 暗色 / 明亮主题切换
- Real-time streaming output
- 实时流式输出
- Tool calling process visualization (collapsible cards showing parameters + result summary)
- 工具调用过程可视化（可折叠卡片，显示参数 + 结果摘要）
- Think process collapsed display
- Think 思考过程折叠展示
- Quick model switching in input box
- 输入框模型快速切换
- Conversation history sidebar (highlight on selection)
- 会话历史侧边栏（选中高亮）
- Workflow stage progress bar
- 工作流阶段进度条

## Installation / 安装

### Requirements / 环境要求
- Node.js >= 16
- Python 3.x (required for GUI automation, optional / GUI 自动化需要，可选)
- pyautogui + Pillow (required for GUI automation, `pip install pyautogui Pillow` / GUI 自动化需要)

### Method 1: NPM Global Install (Recommended / 推荐)

```bash
# Global install / 全局安装
npm install -g o-yuan

# Start service / 启动服务
oyuan start

# Or specify port / 或指定端口
oyuan start --port 8080

# Check status / 查看状态
oyuan status

# Check config path / 查看配置路径
oyuan config
```

Then open `http://127.0.0.1:3088` in your browser

然后浏览器打开 `http://127.0.0.1:3088`

### Method 2: One-Click Deployment Script / 一键部署脚本

**Windows (PowerShell):**
```powershell
# After cloning the repo, execute in the project directory
# 克隆仓库后，在项目目录执行
.\install.ps1

# Optional parameters / 可选参数
.\install.ps1 -SkipBuild      # Skip C++ compilation (use JS fallback / 跳过 C++ 编译，用 JS 降级)
.\install.ps1 -StartNow       # Start immediately after installation / 安装后立即启动
.\install.ps1 -Port 8080      # Specify port / 指定端口
```

**Linux / macOS:**
```bash
# After cloning the repo, execute in the project directory
# 克隆仓库后，在项目目录执行
chmod +x install.sh
./install.sh

# Optional parameters / 可选参数
./install.sh --skip-build      # Skip C++ compilation / 跳过 C++ 编译
./install.sh --port=8080       # Specify port / 指定端口
```

### Method 3: Install from Source / 从源码安装

```bash
# Clone the repo / 克隆仓库
git clone https://github.com/ZnFr60/O-yuan.git
cd O-yuan

# Install dependencies (minimal, only node-addon-api + ws / 极少，仅 node-addon-api + ws)
npm install

# Start service / 启动服务
npm start
```

Then open `http://127.0.0.1:3088` in your browser

然后浏览器打开 `http://127.0.0.1:3088`

### C++ Native Extension (Optional, Performance Acceleration / 可选，性能加速)

```bash
# Windows
npm run build:win

# macOS / Linux
npm run build
```

Automatically falls back to pure JS implementation when not compiled, with full functionality.

未编译时自动降级为纯 JS 实现，功能完整。

## Configuration / 配置

On first launch, `config/config.json` will be automatically generated from `config/config.default.json`.

首次启动会自动从 `config/config.default.json` 生成 `config/config.json`。

### Model Configuration / 模型配置

Add in Settings page → Model Management:

在设置页面 → 模型管理中添加：

| Field / 字段 | Description / 说明 |
|------|------|
| Name / 名称 | Custom display name / 自定义显示名 |
| Model ID / 模型 ID | e.g. `deepseek-chat`、`gpt-4o-mini` |
| Base URL | Provider API address / 供应商 API 地址 |
| API Key | Secret key (displayed as password by default, toggleable visibility / 密钥，默认密码形式显示，可切换可见) |
| Weight / 权重 | Voting weight during deliberation (0-2 / 合议时的投票权重) |
| Primary Model / 主模型 | Set as deliberation coordinator (single select / 设为合议协调者，单选) |
| Thinking Control / 思考控制 | native (temperature mapping / 温度映射) / prompt_override (reasoning constraints / 推理约束) |
| Vision | Whether image recognition is supported / 是否支持图像识别 |

Supports any OpenAI-compatible API: DeepSeek, OpenAI, Qwen, Zhipu, Ollama, etc.

支持任意 OpenAI 兼容 API：DeepSeek、OpenAI、通义千问、智谱、Ollama 等。

### Permission Levels / 权限等级

| Level / 等级 | Capabilities / 能力 |
|------|------|
| `none` | Chat only, no tools / 仅对话，无工具 |
| `medium` | Read-only tools (file read, search, screenshot / 只读工具：文件读取、搜索、截图) |
| `full` | All tools (command execution, file writing, GUI control / 全部工具：命令执行、文件写入、GUI 控制) |

Default is `full`, developers adjust as needed.

默认 `full`，开发者自行调整。

## Architecture / 架构

```
┌─────────────────────────────────────────┐
│          Frontend (public/)             │
│  HTML + CSS + Vanilla JS (no framework) │
│  前端 HTML + CSS + 原生 JS（无框架依赖）│
└──────────────────┬──────────────────────┘
                   │ HTTP / SSE
┌──────────────────▼──────────────────────┐
│       Service Layer (src/js/server.js)  │
│  REST API + SSE streaming + static files│
│  服务层 REST API + SSE 流式 + 静态文件  │
├──────────────────────────────────────────┤
│     Core Scheduling (src/js/core/)      │
│  agent-loop · config · session · logger │
│  核心调度 permissions · hooks · features│
│                   · cache                │
├──────────────────────────────────────────┤
│    Model Layer (src/js/deliberation/)   │
│  scheduler · provider · model-profiles  │
│  模型层                                  │
├──────────────────────────────────────────┤
│      Tools Layer (src/js/tools/)        │
│  tool-runner · filesystem · shell        │
│  code-runtime · git · todo · gui         │
│  工具层 subagent · search · rag · plugins│
├──────────────────────────────────────────┤
│   Native Extension (src/cpp/) Optional   │
│  C++ Addon (perf boost, auto-fallback)   │
│  原生扩展（性能加速，未编译自动降级）    │
└──────────────────────────────────────────┘
```

## Security Notice / 安全说明

This project **does not include by default** the following security mechanisms, which developers should build as needed:

本项目**默认不包含**以下安全机制，由开发者按需自行搭建：

- ❌ Command sandbox (no blacklist/whitelist filtering / 无黑名单/白名单过滤)
- ❌ Dangerous operation approval confirmation / 危险操作审批确认
- ❌ LAN access password / 局域网访问密码
- ❌ Configuration encryption (API Key stored in plain text / API Key 明文存储)
- ❌ Operation audit log / 操作审计日志

**The only retained security control**: Three-level permission system (none / medium / full).

**保留的唯一安全控制**：三级权限等级（none / medium / full）。

> ⚠️ This project is intended for developers and technical users. When deploying in untrusted environments, please add network isolation, container sandbox, reverse proxy authentication, and other security measures as needed.
>
> ⚠️ 本项目面向开发者和技术用户。在不可信环境部署时，请自行添加网络隔离、容器沙箱、反向代理鉴权等安全措施。

## License / 许可证

MIT License
