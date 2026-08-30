# O-yuan (启原) v3.0

> 跨平台通用智能体 Agent — 自研架构，复现并完善业界主流 Agent 的核心能力。

## 项目简介

O-yuan（启原）是一个完全自托管的通用智能体 Agent，采用 **Node.js 上层调度 + C++ 原生扩展（可选）** 的混合架构。设计目标是在保持极简依赖的前提下，提供媲美商业 Agent 的工具调用、多模型合议、GUI 自动化、持久化 Shell 等能力。

**核心哲学**：安全策略由开发者自行决定。配置明文存储、无沙箱强制、无密码鉴权——所有安全边界交给使用者按需搭建。

## 核心特性

### 🤖 Agent Loop（原生 function calling）
- 基于 OpenAI 标准 `tool_calls` 的原生工具调用循环
- 无步数硬限制（默认 50 步，可配置）
- 无工具结果截断，完整返回
- 支持同一轮并行调用多个工具
- 流式输出（token 逐块实时渲染）

### 🔀 多模型合议调度
- 四种模式：`fast`（快速返回）/ `equal`（均等投票）/ `weighted`（加权投票）/ `deep`（深度二次汇总）
- 支持指定**主模型（协调者）**，负责汇总多方结果
- 模型故障自动黑名单（连续失败达阈值自动跳过）
- 思考深度控制（native 温度映射 / prompt_override 推理约束）

### 🛠 28 个内置工具

| 分类 | 工具 |
|------|------|
| **文件系统** | `list_dir`、`read_file`、`write_file`、`edit_file`、`search_files`、`glob` |
| **Shell** | `shell_exec`（持久化）、`shell_status`、`shell_cd`、`shell_close`、`run_command` |
| **代码运行** | `run_code`（Python / JavaScript 隔离执行） |
| **网络** | `web_fetch`（网页获取，HTML 自动转纯文本） |
| **开发** | `git`（status/log/diff/commit/branch/pull/push 等）、`todo`（任务管理） |
| **GUI 自动化** | `gui_screenshot`、`gui_mouse`、`gui_keyboard`、`gui_screen`、`gui_screencrop` |
| **Agent** | `subagent`（子代理委派，支持进程隔离） |
| **其他** | `kb_query`（知识库）、`web_search`、`load_skill`、`workflow` |

### 🖥 GUI 自动化
- 基于 Python + pyautogui 的虚拟鼠标/键盘/截屏
- 支持 vision 模型直接看图操作
- 自动截图注入（检测到屏幕相关意图时自动截屏）

### 💾 持久化与本地存储
- 对话历史：`logs/sessions.json`（结构化）+ `logs/conversations/*.txt`（人类可读明文）
- 配置：`config/config.json`（明文 JSON，含 API Key）
- 知识库：`config/kb/`（本地 RAG）
- 角色人设：`config/roles/`
- 技能包：`config/skills/`

### 🎨 前端界面
- 暗色 / 明亮主题切换
- 实时流式输出
- 工具调用过程可视化（可折叠卡片，显示参数 + 结果摘要）
- Think 思考过程折叠展示
- 输入框模型快速切换
- 会话历史侧边栏（选中高亮）
- 工作流阶段进度条

## 安装

### 环境要求
- Node.js >= 16
- Python 3.x（GUI 自动化需要，可选）
- pyautogui + Pillow（GUI 自动化需要，`pip install pyautogui Pillow`）

### 快速安装

```bash
# 克隆仓库
git clone https://github.com/yourname/o-yuan.git
cd o-yuan

# 安装依赖（极少，仅 node-addon-api + ws）
npm install

# 启动服务
npm start
```

然后浏览器打开 `http://127.0.0.1:3088`

### C++ 原生扩展（可选，性能加速）

```bash
# Windows
npm run build:win

# macOS / Linux
npm run build
```

未编译时自动降级为纯 JS 实现，功能完整。

## 配置

首次启动会自动从 `config/config.default.json` 生成 `config/config.json`。

### 模型配置

在设置页面 → 模型管理中添加：

| 字段 | 说明 |
|------|------|
| 名称 | 自定义显示名 |
| 模型 ID | 如 `deepseek-chat`、`gpt-4o-mini` |
| Base URL | 供应商 API 地址 |
| API Key | 密钥（默认密码形式显示，可切换可见） |
| 权重 | 合议时的投票权重（0-2） |
| 主模型 | 设为合议协调者（单选） |
| 思考控制 | native（温度映射）/ prompt_override（推理约束） |
| Vision | 是否支持图像识别 |

支持任意 OpenAI 兼容 API：DeepSeek、OpenAI、通义千问、智谱、Ollama 等。

### 权限等级

| 等级 | 能力 |
|------|------|
| `none` | 仅对话，无工具 |
| `medium` | 只读工具（文件读取、搜索、截图） |
| `full` | 全部工具（命令执行、文件写入、GUI 控制） |

默认 `full`，开发者自行调整。

## 架构

```
┌─────────────────────────────────────────┐
│              前端 (public/)              │
│  HTML + CSS + 原生 JS（无框架依赖）     │
└──────────────────┬──────────────────────┘
                   │ HTTP / SSE
┌──────────────────▼──────────────────────┐
│           服务层 (src/js/server.js)      │
│  REST API + SSE 流式 + 静态文件服务      │
├──────────────────────────────────────────┤
│         核心调度 (src/js/core/)          │
│  agent-loop · config · session · logger  │
│  permissions · hooks · features · cache  │
├──────────────────────────────────────────┤
│       模型层 (src/js/deliberation/)      │
│  scheduler · provider · model-profiles   │
├──────────────────────────────────────────┤
│         工具层 (src/js/tools/)           │
│  tool-runner · filesystem · shell        │
│  code-runtime · git · todo · gui         │
│  subagent · search · rag · plugins       │
├──────────────────────────────────────────┤
│        原生扩展 (src/cpp/) 可选           │
│  C++ Addon（性能加速，未编译自动降级）    │
└──────────────────────────────────────────┘
```

## 安全说明

本项目**默认不包含**以下安全机制，由开发者按需自行搭建：

- ❌ 命令沙箱（无黑名单/白名单过滤）
- ❌ 危险操作审批确认
- ❌ 局域网访问密码
- ❌ 配置加密（API Key 明文存储）
- ❌ 操作审计日志

**保留的唯一安全控制**：三级权限等级（none / medium / full）。

> ⚠️ 本项目面向开发者和技术用户。在不可信环境部署时，请自行添加网络隔离、容器沙箱、反向代理鉴权等安全措施。

## 许可证

MIT License
