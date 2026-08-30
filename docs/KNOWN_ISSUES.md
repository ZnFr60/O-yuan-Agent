# 已知兼容问题清单 (Known Issues)

> 本文件记录开发与跨平台适配过程中发现的问题、原因与当前状态。随版本持续更新。

## 1. 本机（Windows x64 开发机）未安装 MSVC，原生扩展暂以 JS 降级运行

- **现象**：`npm run build` 报 `gyp ERR! find VS ... Could not find any Visual Studio installation`。
- **原因**：本机未安装 Visual Studio Build Tools（C++ 工作负载），且系统盘剩余空间不足（约 2GB）无法完成 VS 安装。
- **当前状态**：不影响使用——Conclave 原生加载器自动回退纯 JS 实现（`src/js/core/native.js`），全部功能可用，仅失去 C++ 加速。
- **解决**：在有足够磁盘空间的机器上安装 VS Build Tools 后执行 `npm run build`；或 Linux/macOS 安装 g++/Xcode CLT。
- **验证方式**：`/api/status` 中 `native` 字段为 `false`；编译成功后为 `true`。

## 2. C++ 源码尚未在本机实际编译验证

- **现象**：`src/native/*.cc` 已编写完成且通过人工审查，但受限于问题 1 未在本机执行编译。
- **风险**：可能存在的编译期小问题（如头文件引用、宏）需在有编译器的环境验证。
- **当前状态**：代码已按 C++17 编写，使用 Node-API（N-API）C API + 少量 std，兼容性风险低；binding.gyp 已配置 win/mac/linux 三段条件。

## 3. 联网搜索依赖 DuckDuckGo HTML 接口，稳定性受外部影响

- **现象**：默认搜索服务商为 duckduckgo（免 key）。
- **原因**：HTML 接口无官方 SLA，可能因反爬或网络环境不可达。
- **当前状态**：搜索默认关闭（`search.enabled=false`），按需开启；失败时聊天流程自动降级（仅记录 warn）。
- **后续计划**：接入 Serper/Bing 等可配置 key 的服务商。

## 4. RAG 相似度阈值需按语料校准

- **现象**：早期使用字符 bigram Jaccard，中文短查询得分极低（0.03），导致检索不到内容。
- **已修复**：改为 余弦(unigram)*0.6 + 关键词命中*0.35 + 长度项*0.05 的混合评分，默认阈值 0.15；短中文查询可正常命中。
- **注意**：不同语料下可微调 `config.json → rag.similarityThreshold`。

## 5. Windows 控制台中文日志乱码

- **现象**：日志文件/控制台在部分终端（如默认 GBK 代码页）显示乱码（如 “鐭ヨ瘑搴”）。
- **原因**：Node 输出 UTF-8，而部分 Windows 终端代码页为 GBK。
- **当前状态**：日志文件本身为 UTF-8，用 VS Code 等查看正常；控制台乱码不影响功能。
- **建议**：`chcp 65001` 切换 UTF-8 代码页后启动。

## 6. OpenAI 兼容 API 需要配置真实模型 Key 才能完成对话

- **现象**：`/v1/chat/completions` 未配置 apiKey 时返回 500 `所有模型均调用失败: HTTP 401`。
- **原因**：内部合议需要调用真实模型服务。
- **当前状态**：符合预期；配置 Key 后可用。
- **注意**：兼容端点完整支持 `stream` 参数（SSE 分块输出）。

## 7. 缓存语义模糊命中依赖 recentKeys 环形缓冲

- **现象**：fuzzy 命中仅在最近 64 个 key 内查找相似项。
- **原因**：权衡命中率与 CPU 开销（每次 miss 做 ≤64 次余弦比较）。
- **当前状态**：`cache.fuzzyThreshold` 默认 0.82，可调（1.0 关闭模糊命中）。

## 8. 权限安全锁行为说明

- 局域网开放且未设置密码 → 最高权限强制 medium（不可绕过）。
- 完全访问必须先设置密码。
- 这是硬性安全约束，不属于缺陷。

---

## 验证矩阵（当前开发机 Windows x64, Node v24.19.0）

| 项 | 结果 |
|---|---|
| 服务启动 / 静态页面 | ✅ |
| /api/status / features / roles / kb / cache / risk / tasks | ✅ |
| 角色 MD 解析（含人格字段） | ✅ |
| KB 检索（Worker 线程 + eval 模式） | ✅ |
| OpenAI 兼容 /v1/models + /v1/chat/completions | ✅（Key 未配置时按预期报错） |
| 功能开关切换 | ✅ |
| 权限安全锁（full 无密码→medium） | ✅ |
| 密码设置（SHA-256 哈希存储） | ✅ |
| 缓存导出/导入/清空 | ✅ |
| C++ 原生扩展编译 | ⚠️ 待有编译器环境验证 |
| Linux/macOS/ARM64 实机验证 | ⏳ 待进行 |
## 9. GUI 自动化依赖 pyautogui/Pillow

- **现象**：调用 /api/gui/* 时报 `缺少 pyautogui/Pillow`。
- **原因**：GUI 自动化桥接（src/tools/gui_bridge.py）依赖 Python 的 pyautogui 与 Pillow，未安装时该特性不可用。
- **当前状态**：不影响其余功能；安装 `pip install pyautogui pillow` 即可启用。
- **安全**：仅完全访问(full)权限允许 GUI 操作，其余权限返回 403。

## 10. GUI 操作的副作用与风险提示

- GUI 自动化会真实移动鼠标/点击/键入，可能触发意外窗口或操作。
- 建议仅在受控环境使用；pyautogui 已启用 FAILSAFE（鼠标移到左上角可紧急中止）。
- 跨平台：Linux Wayland 下部分键入/移动受限（建议 X11）；macOS 需辅助功能授权。
