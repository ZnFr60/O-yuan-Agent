# 跨平台编译与部署指南

## 一、C++ 原生扩展编译

Conclave 的原生扩展使用 **node-addon-api (C++)** 编写，通过 `binding.gyp` + node-gyp 编译，支持 x86-64 与 ARM64。

### 前提条件

| 平台 | 编译器要求 | 说明 |
|---|---|---|
| Windows | Visual Studio Build Tools 2019/2022（含“使用 C++ 的桌面开发”工作负载） | 或 Visual Studio Community/Professional |
| Linux (x86_64) | g++ ≥ 8 / clang++ ≥ 10，make，python3 | Debian/Ubuntu: `sudo apt install build-essential python3` |
| Linux (ARM64，树莓派) | 同上（g++ aarch64） | 树莓派 4/5 Debian 自带 |
| macOS | Xcode Command Line Tools | `xcode-select --install` |

Node 版本建议 ≥ 16；首次编译会从网络下载 Node headers（或使用本地 `nodedir`）。

### 编译步骤

```bash
npm install            # 安装 node-addon-api
npm run build          # node-gyp rebuild（自动匹配当前平台架构）
```

如需指定架构：

```bash
npm run build:win      # Windows x64
npm run build:arm64    # ARM64（树莓派/Apple Silicon/ARM 云服务器）
node-gyp rebuild --arch=arm64   # 交叉编译（需目标架构工具链）
```

编译产物：`build/Release/conclave_native.node`

> **重要**：未安装编译器或编译失败时，Conclave 自动降级为纯 JS 实现（功能完整，仅失去 C++ 加速），不会导致服务无法启动。

### 各平台常见坑

#### Windows
- 必须安装 VS Build Tools，仅装 Node 不行；安装后重启终端。
- 若 node-gyp 找不到 VS：在“VS Installer → 修改 → 单个组件”勾选“Windows 10/11 SDK”与“MSVC v143”。
- PowerShell 执行策略限制时用 `cmd` 或 `powershell -ExecutionPolicy Bypass`。
- 报 `MSB4019` 通常是缺少 SDK 组件。

#### Linux (Debian/Ubuntu)
- 先装依赖：`sudo apt update && sudo apt install -y build-essential python3 make g++`。
- 缺少 `make` 会报 “gyp ERR! build error”。
- 树莓派（ARM64）直接用系统包即可，无需交叉编译。

#### macOS
- `xcode-select --install` 后若仍报错，执行 `sudo xcodebuild -license accept`。
- Apple Silicon (ARM64) 默认直接编译 ARM64 产物。

---

## 二、Node 层部署

### 依赖

仅需 Node.js 运行时（≥16）。项目零外部运行时依赖（HTTP 使用 Node 原生模块实现）。

```bash
npm install   # 仅安装 node-addon-api（编译原生扩展所需）
```

### 启动

```bash
node src/js/server.js          # 前台运行
npm start
npm run dev                    # 开发模式
```

### 后台运行

#### Linux / macOS

```bash
nohup node src/js/server.js > logs/server.log 2>&1 &
# 或用 systemd/pm2：
pm2 start src/js/server.js --name conclave
```

#### Windows

```bat
start /B node src/js/server.js
# 或用任务计划程序 / NSSM 注册为服务
```

---

## 三、网络与端口

- 默认监听 `127.0.0.1:3088`（仅本机）。
- 改为 `0.0.0.0:3088` 开放局域网：设置面板 → 局域网 → 选择 0.0.0.0，按安全流程操作（建议先设置密码）。
- 端口修改：设置面板 → 局域网 → 端口；保存后需重启服务生效。
- 防火墙：Windows 需放行端口（入站规则）；Linux 用 `sudo ufw allow 3088`。

## 四、目录与路径约定

- 所有路径由 `path` 模块解析，兼容 Windows 反斜杠与 Unix 正斜杠。
- 日志目录 `logs/`、角色 `config/roles/`、知识库 `config/kb/` 均可在配置中改为自定义绝对路径。
- 自定义背景图片存放在 `public/custom_bg/`。

## 五、常见问题（FAQ）

1. **服务启动但页面打不开** → 检查端口占用：`netstat -ano | findstr 3088`（Win）/ `ss -tlnp | grep 3088`（Linux）。
2. **模型全部报错** → 检查 `config/config.json` 中 baseUrl / apiKey；日志会脱敏显示错误。
3. **局域网访问提示需要密码** → 在设置中设置密码（本机 127.0.0.1 不受影响）。
4. **想恢复默认配置** → 删除 `config/config.json` 重启，将重新生成。
5. **原生加速未生效（显示 JS）** → 未编译或编译失败，见本文档第一部分。

## 六、安全清单

- 局域网开放务必设置密码；密码仅存 SHA-256 哈希。
- 完全访问权限需先设置 Web 登录密码方可启用。
- 日志自动脱敏 API Key / 密码 / Token。
- 配置文件 `config.json` 含明文 API Key，请勿提交到公共仓库（已在 .gitignore 外建议加密保管）。