# 开发文档（架构与模块）

## 一、总体架构

```
┌─────────────────────────────────────────────────────┐
│                  Web 前端 (public/)                 │
│        双主题 · 自定义背景 · 人格卡片 · 设置面板     │
└────────────────────────┬────────────────────────────┘
                         │ HTTP / SSE
┌────────────────────────▼────────────────────────────┐
│              Node.js 上层调度 (src/js)              │
│  路由 · 鉴权 · 权限 · 会话 · OpenAI兼容API           │
│  ┌────────────┐ ┌───────────┐ ┌──────────────────┐   │
│  │ 合议调度器  │ │ 聊天编排   │ │ 缓存/风控/队列    │   │
│  │ (多模型投票)│ │ (RAG+搜索) │ │ (LRU+TTL+风控)   │   │
│  └─────┬──────┘ └─────┬─────┘ └────────┬─────────┘   │
└────────┼──────────────┼────────────────┼─────────────┘
         │              │                │
┌────────▼──────────────▼────────────────▼─────────────┐
│        C++ 原生扩展 (src/native, node-addon-api)     │
│  归一化哈希 · 相似度 · 缓存预处理 · 角色渲染 · KB预处理│
└──────────────────────────────────────────────────────┘
```

## 二、模块清单

### src/js/core

| 文件 | 职责 |
|---|---|
| config.js | 配置加载/合并/持久化；路径统一用 path 模块 |
| logger.js | DEBUG/INFO/WARN/ERROR 分级；按日滚动；敏感字段自动脱敏 |
| native.js | C++ 扩展加载器；缺失时自动降级 JS 实现（同接口） |
| cache.js | LRU+TTL 缓存；语义模糊命中；黑白名单；导出/导入 |
| auth.js | 密码 SHA-256 哈希；会话管理；回环识别 |
| permissions.js | 三级权限矩阵与不可绕过安全锁 |
| roles.js | MD 人格档案解析（名称/形象/语气/问候语/风格/准则/禁止） |
| kb.js | 知识库加载/分块/检索（Worker 线程评分） |
| features.js | 模块化功能开关注册表与开关 |

### src/js/deliberation

| 文件 | 职责 |
|---|---|
| scheduler.js | 四种合议模式；思考深度映射；故障黑名单；缓存接入 |
| provider.js | OpenAI 兼容协议 HTTP 调用；超时/错误处理 |
| model-profiles.js | 主流模型档案（上下文/温度范围/固定温度模型） |

### src/js/services & tools & routes

| 文件 | 职责 |
|---|---|
| services/chat-service.js | 聊天编排：RAG→搜索→角色→风控→合议 |
| tools/search.js | DuckDuckGo 搜索（权限管控） |
| tools/task-queue.js | 并发控制/排队/超时/状态看板 |
| tools/risk.js | Token 上限/成本预估/消费统计 |
| tools/plugins.js | 生命周期钩子 |
| routes/openai-compat.js | /v1/chat/completions 与 /v1/models |

### src/native (C++)

| 文件 | 职责 |
|---|---|
| conclave_native.cc | N-API 绑定入口 |
| hash.cc | FNV-1a 64 稳定哈希（跨平台一致） |
| textnorm.cc | 文本归一化（空白折叠/大小写/UTF-8 保留） |
| similarity.cc | 余弦 / Jaccard / Levenshtein |
| kb.cc | 分块与关键词权重 |
| roledl.cc | 角色模板渲染 {placeholder} 替换 |

## 三、合议流程

1. 前端 /api/chat 或 OpenAI 兼容 /v1/chat/completions 进入。
2. 聊天编排：RAG 检索（Worker 线程）→（可选）联网搜索 → 角色人设渲染 → 风控预检。
3. 合议调度器：计算缓存 Key（输入+角色+思考等级+KB 片段+合议配置）→ 查缓存（含模糊命中）。
4. 未命中：并行调用所有未进黑名单的模型（思考参数按模型档案校准）。
5. 按模式聚合：fast(首个) / equal(共识) / weighted(权重最高) / deep(二次汇总)。
6. 写缓存 → 插件钩子 onDeliberationDone → 返回。

## 四、缓存设计（最大化命中率）

- Key：归一化输入(去空白/大小写/参数序) + 角色 + 思考等级 + KB 检索片段 + 合议配置，任一变化即失效。
- 淘汰：LRU 为主，扫描时顺带清理过期(TTL)项。
- 语义模糊命中：最近 64 个 key 环形缓冲；miss 时计算余弦相似度，≥ fuzzyThreshold(0.82) 直接共享结果。
- 黑白名单：黑名单优先；白名单非空时仅白名单可缓存。
- 运维：Web 面板展示命中率/命中/未命中/容量；支持导出/导入备份。

## 五、权限模型

三级权限仅约束"智能体/工具执行"能力；操作员对本机面板的配置修改由 isAdmin（回环或会话）守卫。

- none：仅 LLM 对话
- medium：可读文件/进程/硬件状态；禁写删、禁 Shell、禁改配置
- full：完整 Shell / 任意读写 / 修改配置
- 安全锁：局域网+无密码 → 强制 medium；full 必须先设密码

## 六、跨平台约束落实

1. 所有路径使用 path 模块（join/resolve/isAbsolute），无硬编码斜杠。
2. 系统命令执行区分平台（Windows cmd/powershell 与 Unix shell 分支）。
3. binding.gyp 含 win/mac/linux 三段条件，支持 x64/ARM64。
4. 日志/配置/角色/知识库目录支持相对路径与自定义绝对路径。
5. 网络监听 0.0.0.0 行为三平台统一。

## 七、测试建议

```bash
node --check src/js/*.js src/js/**/*.js   # 语法检查
node src/js/server.js                     # 启动
# 浏览器访问 http://127.0.0.1:3088 验证 UI
```