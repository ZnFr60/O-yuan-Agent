// server.js - Conclave Web 服务入口
// 使用 Node 原生 http 模块实现路由（零外部运行时依赖），提供：
//   - 静态前端资源 (public/)
//   - REST API（配置 / 角色 / 知识库 / 缓存 / 风控 / 任务 / 权限 / 搜索 / 聊天）
//   - 鉴权与会话管理
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const config = require('./core/config');
const logger = require('./core/logger');
const permissions = require('./core/permissions');
const cache = require('./core/cache');
const roles = require('./core/roles');
const kb = require('./core/kb');
const native = require('./core/native');
const searchTool = require('./tools/search');
const risk = require('./tools/risk');
const taskQueue = require('./tools/task-queue');
const plugins = require('./tools/plugins');
const chatService = require('./services/chat-service');
const scheduler = require('./deliberation/scheduler');
const provider = require('./deliberation/provider');
const openaiCompat = require('./routes/openai-compat');
const sdkRpc = require('./routes/sdk-rpc');
const features = require('./core/features');
const guiAuto = require('./tools/gui-automation');
const sessionStore = require('./core/session');
const chatStream = require('./services/chat-stream');
const { mcpHandler, healthInfo: mcpHealthInfo } = require('../mcp/mcp-handler');
const guiAgent = require('./services/gui-agent');
const planMode = require('./core/plan-mode');
const webhook = require('./core/webhook');
const credentials = require('./core/credentials');
const hooks = require('./core/hooks');

const ROOT = config.root();
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8', '.map': 'application/json'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(new Error('too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

// 开发者导向：无鉴权，所有访问直接放行。权限等级由 permissions.global 控制。
function authGate(req) {
  return { ok: true, role: permissions.effective };
}

// 管理面板：开发者导向，所有访问视为管理员。
function isAdmin(req) {
  return true;
}

function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // 防目录穿越
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { sendJSON(res, 403, { error: 'forbidden' }); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // 尝试 index.html 兜底（SPA）
      const idx = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(idx, (e2, buf) => {
        if (e2) { sendJSON(res, 404, { error: 'not found' }); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, parsed) {
  const g = authGate(req);
  const p = parsed.pathname;
  const method = req.method;

  // ---- 聊天（SSE 流式） ----
  if (p === '/api/chat/stream' && method === 'POST') {
    const body = await readBody(req);
    const msg = body.message || '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const emit = (event, data) => {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    };
    try {
      await chatStream.handleStream(msg, { ...g, sessionId: body.sessionId }, emit);
    } catch (e) {
      logger.error('流式聊天失败', { error: e.message });
      emit('error', { error: e.message });
    }
    res.end();
    return;
  }
  if (p === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await chatService.handleMessage(body.message || '', { ...g, sessionId: body.sessionId });
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      logger.error('聊天处理失败', { error: e.message });
      return sendJSON(res, 500, { ok:false, error: e.message });
    }
  }
  // ---- 会话 ----
  if (p === '/api/session' && method === 'GET') {
    return sendJSON(res, 200, { ...sessionStore.stats(), groups: sessionStore.list() });
  }
  if (p === '/api/session/clear' && method === 'POST') {
    const body = await readBody(req);
    sessionStore.clear(body.sessionId || 'default');
    return sendJSON(res, 200, { ok:true });
  }
  // 历史会话消息（切换会话时恢复）
  if (p === '/api/session/messages' && method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, { ok:true, sessionId: body.sessionId || 'default', history: sessionStore.getHistory(body.sessionId || 'default') });
  }
  // 重命名会话
  if (p === '/api/session/rename' && method === 'POST') {
    const body = await readBody(req);
    const title = sessionStore.rename(body.sessionId || 'default', body.title);
    return sendJSON(res, 200, { ok:true, title });
  }
  // ---- 计划模式 ----
  if (p === '/api/plan/mode' && method === 'POST') {
    const body = await readBody(req);
    const active = !!body.active;
    if (active) planMode.enter(); else planMode.leave();
    return sendJSON(res, 200, { ok:true, active: planMode.isActive() });
  }

  // ---- 状态汇总 ----
  if (p === '/api/status' && method === 'GET') {
    const serverCfg = config.get(['server']) || {};
    return sendJSON(res, 200, {
      native: native.isNative(),
      cache: cache.snapshot(),
      kb: kb.stats(),
      roles: roles.roles.map(r=>({ id:r.id, name:r.name })),
      selectedRole: roles.selectedRole?.id || null,
      roleEnabled: roles.enabled,
      risk: risk.snapshot(),
      tasks: taskQueue.status(),
      blacklist: scheduler.blacklistStatus(),
      models: (config.get(['models'])||[]).map(m=>({ id:m.id, name:m.name, model:m.model, baseUrl:m.baseUrl, apiKey:m.apiKey || '', enabled:m.enabled, weight:m.weight, think_control_mode:m.think_control_mode, vision:m.vision, primary:m.primary, timeoutMs:m.timeoutMs, maxTokens:m.maxTokens })),
      think: config.get(['think']),
      deliberationMode: config.get(['deliberation','mode']),
      canDeliberate: scheduler.canDeliberate(),
      effectiveApiCount: scheduler.effectiveApiCount(),
      permissions: { effective: permissions.effective, configured: config.get(['permissions','global']) },
      planMode: { active: planMode.isActive() },
      webhook: webhook.status(),
      hooks: hooks.status(),
      credentials: { count: credentials.list().length },
      lan: { host: serverCfg.host, port: serverCfg.port },
      ui: config.get(['ui']) || {},
      features: features.all(),
      session: sessionStore.stats(),
      toolCalls: true,
      version: require('../../package.json').version
    });
  }

  // ---- 配置 ----
  if (p === '/api/config' && method === 'GET') {
    const c = config.data;
    // 脱敏模型 API Key
    const sanitized = JSON.parse(JSON.stringify(c));
    (sanitized.models||[]).forEach((m) => { if (m.apiKey) m.apiKey = '***'; });
    return sendJSON(res, 200, sanitized);
  }
  // 模型连接验证（测试密钥/供应商/模型是否连通）
  if (p === '/api/models/test' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      const result = await provider.testConnection(body);
      logger.info('模型连接测试', { ok: result.ok, model: body.model, latency: result.latency });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { ok:false, error: e.message });
    }
  }
  // 自动检测服务商可用模型列表
  if (p === '/api/models/list' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      const result = await provider.listModels(body);
      logger.info('模型列表检测', { ok: result.ok, baseUrl: body.baseUrl, count: result.count });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { ok:false, error: e.message });
    }
  }

  // 配置导出（默认不导出密钥；includeKeys=true 时导出明文，需管理员）
  if (p === '/api/config/export' && method === 'GET') {
    const includeKeys = url.parse(req.url, true).query.includeKeys === 'true';
    if (includeKeys && !isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'导出密钥需要管理员权限' });
    const out = JSON.parse(JSON.stringify(config.data));
    if (!includeKeys) {
      (out.models||[]).forEach((m) => { if (m.apiKey) m.apiKey = '***'; });
    }
    return sendJSON(res, 200, { ok:true, exportedAt: Date.now(), data: JSON.stringify(out) });
  }
  // 配置导入
  if (p === '/api/config/import' && method === 'POST') {
    if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body.data);
      // 只允许导入白名单字段，防止覆盖 server 哈希等安全项
      const allowed = ['models', 'think', 'deliberation', 'cache', 'rag', 'search', 'risk', 'taskQueue', 'logging', 'ui', 'session'];
      for (const k of allowed) {
        if (parsed[k] != null) config.set([k], parsed[k]);
      }
      // 刷新依赖
      permissions.computeEffective({});
      if (parsed.rag) kb.init();
      if (parsed.cache) cache.init();
      if (parsed.deliberation) scheduler.init();
      return sendJSON(res, 200, { ok:true, imported: allowed.filter(k => parsed[k] != null) });
    } catch (e) {
      return sendJSON(res, 400, { ok:false, error: '配置导入失败: ' + e.message });
    }
  }
  if (p === '/api/config' && method === 'POST') {
    // 管理面板配置：需管理员（本机或有效会话）
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      if (body.permissions) {
        config.set(['permissions','global'], body.permissions);
      }
      if (body.server) config.set(['server'], { ...config.get(['server']), ...body.server });
      if (body.think) config.set(['think'], { ...config.get(['think']), ...body.think });
      if (body.deliberation) config.set(['deliberation'], { ...config.get(['deliberation']), ...body.deliberation });
      if (body.models) {
        // apiKey 保护：前端传空字符串时保留原已保存的 key（避免误清空）
        const current = config.get(['models']) || [];
        const merged = body.models.map((m) => {
          const old = current.find((c) => c.id === m.id);
          if (m.apiKey === '' || m.apiKey == null) {
            return { ...m, apiKey: old ? old.apiKey : '' };
          }
          return m;
        });
        config.set(['models'], merged);
        scheduler.resetBlacklist(); // 模型配置变更后清空故障黑名单
      }
      if (body.cache) config.set(['cache'], { ...config.get(['cache']), ...body.cache });
      if (body.rag) config.set(['rag'], { ...config.get(['rag']), ...body.rag });
      if (body.search) config.set(['search'], { ...config.get(['search']), ...body.search });
      if (body.ui) config.set(['ui'], { ...config.get(['ui']), ...body.ui });
      // 触发刷新
      permissions.computeEffective({});
      if (body.rag) kb.init();
      if (body.cache) cache.init();
      if (body.deliberation) scheduler.init();
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 403, { ok:false, error: e.message });
    }
  }

  // ---- 角色 ----
  if (p === '/api/roles' && method === 'GET') {
    return sendJSON(res, 200, { roles: roles.roles, selected: roles.selectedRole?.id || null, enabled: roles.enabled });
  }
  if (p === '/api/roles' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      const file = roles.createRole(body);
      return sendJSON(res, 200, { ok:true, file });
    } catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }
  if (p === '/api/roles/select' && method === 'POST') {
    const body = await readBody(req);
    roles.select(body.id);
    return sendJSON(res, 200, { ok:true, selected: body.id });
  }
  // AI 角色生成器：自然语言描述 → 生成规范 MD 角色
  if (p === '/api/roles/generate' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      const gen = await roles.generateRole(body.description, g);
      return sendJSON(res, 200, { ok:true, ...gen });
    } catch (e) {
      logger.error('AI角色生成失败', { error: e.message });
      return sendJSON(res, 500, { ok:false, error: e.message });
    }
  }
  if (p === '/api/roles/enabled' && method === 'POST') {
    const body = await readBody(req);
    roles.setEnabled(!!body.enabled);
    return sendJSON(res, 200, { ok:true, enabled: roles.enabled });
  }
  if (p.startsWith('/api/roles/') && method === 'DELETE') {
    const rid = decodeURIComponent(p.split('/').pop());
    try { if (!isAdmin(req)) return sendJSON(res,403,{ok:false,error:'需要管理员权限'}); roles.deleteRole(rid); return sendJSON(res,200,{ok:true}); }
    catch (e) { return sendJSON(res,403,{ok:false,error:e.message}); }
  }
  if (p.startsWith('/api/roles/') && method === 'PUT') {
    const rid = decodeURIComponent(p.split('/').pop());
    const body = await readBody(req);
    try { if (!isAdmin(req)) return sendJSON(res,403,{ok:false,error:'需要管理员权限'}); roles.updateRole(rid, body); return sendJSON(res,200,{ok:true}); }
    catch (e) { return sendJSON(res,403,{ok:false,error:e.message}); }
  }

  // ---- 知识库 ----
  if (p === '/api/kb' && method === 'GET') {
    return sendJSON(res, 200, { ...kb.stats(), enabled: kb.enabled, dir: kb.dir, files: kb.listFiles().map(f=>path.basename(f)) });
  }
  if (p === '/api/kb/reload' && method === 'POST') {
    permissions.require('fileRead');
    const n = kb.reload();
    return sendJSON(res, 200, { ok:true, docs: n });
  }
  if (p === '/api/kb/enabled' && method === 'POST') {
    const body = await readBody(req);
    kb.setEnabled(!!body.enabled);
    return sendJSON(res, 200, { ok:true, enabled: kb.enabled });
  }
  if (p === '/api/kb/search' && method === 'POST') {
    const body = await readBody(req);
    try {
      const res2 = await kb.search(body.query || '', body.limit);
      return sendJSON(res, 200, { ok:true, results: res2.map(r=>({docId:r.docId,score:r.score,snippet:r.snippet})) });
    } catch (e) { return sendJSON(res, 500, { ok:false, error: e.message }); }
  }

  // ---- 缓存 ----
  if (p === '/api/cache' && method === 'GET') return sendJSON(res, 200, cache.snapshot());
  if (p === '/api/cache/clear' && method === 'POST') { cache.clear(); return sendJSON(res, 200, { ok:true }); }
  if (p === '/api/cache/export' && method === 'GET') return sendJSON(res, 200, { ok:true, data: cache.exportBackup() });
  if (p === '/api/cache/import' && method === 'POST') {
    const body = await readBody(req);
    const n = cache.importBackup(body.data);
    return sendJSON(res, 200, { ok:true, imported: n });
  }

  // ---- 风控 ----
  if (p === '/api/risk' && method === 'GET') return sendJSON(res, 200, risk.snapshot());

  // ---- 任务 ----
  if (p === '/api/tasks' && method === 'GET') return sendJSON(res, 200, taskQueue.status());
  if (p === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    const id = taskQueue.submit(async () => {
      // 示例任务：等待并返回
      await new Promise((r) => setTimeout(r, body.delay || 1000));
      return body.payload || 'done';
    }, { label: body.label || 'custom' });
    return sendJSON(res, 200, { ok:true, id });
  }

  // ---- 权限 ----
  if (p === '/api/permissions' && method === 'GET') {
    return sendJSON(res, 200, { effective: permissions.effective, configured: config.get(['permissions','global']), caps: permissions.capabilities() });
  }
  if (p === '/api/blacklist/reset' && method === 'POST') {
    scheduler.resetBlacklist();
    return sendJSON(res, 200, { ok: true, blacklist: scheduler.blacklistStatus() });
  }

  // ---- 搜索 ----
  if (p === '/api/search' && method === 'POST') {
    const body = await readBody(req);
    try {
      const results = await searchTool.search(body.query || '', { max: body.max });
      return sendJSON(res, 200, { ok:true, results });
    } catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }

  // ---- 功能开关 ----
  if (p === '/api/features' && method === 'GET') {
    return sendJSON(res, 200, { features: features.all(), groups: features.groups() });
  }
  if (p === '/api/features' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: '需要管理员权限' });
      const v = features.setEnabled(body.id, !!body.enabled);
      return sendJSON(res, 200, { ok: true, id: body.id, enabled: v });
    } catch (e) { return sendJSON(res, 403, { ok: false, error: e.message }); }
  }

  // ---- GUI 自动化（完全访问权限） ----
  if (p === '/api/gui/screen' && method === 'GET') {
    try { return sendJSON(res, 200, await guiAuto.screen()); }
    catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }
  if (p === '/api/gui/screenshot' && method === 'GET') {
    try {
      const s = await guiAuto.screenshot();
      if (s.ok) return sendJSON(res, 200, s);
      return sendJSON(res, 500, s);
    } catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }
  if (p === '/api/gui/mouse' && method === 'POST') {
    const body = await readBody(req);
    try { return sendJSON(res, 200, await guiAuto.mouse(body.action, body)); }
    catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }
  if (p === '/api/gui/keyboard' && method === 'POST') {
    const body = await readBody(req);
    try { return sendJSON(res, 200, await guiAuto.keyboard(body.action, body)); }
    catch (e) { return sendJSON(res, 403, { ok:false, error: e.message }); }
  }
  // GUI Agent 状态（是否有可用 vision 模型 + 调度配置）
  if (p === '/api/gui/agent/status' && method === 'GET') {
    return sendJSON(res, 200, guiAgent.status());
  }
  // MCP-GUI 服务器状态
  if (p === '/api/mcp/status' && method === 'GET') {
    return sendJSON(res, 200, { ...mcpGuiStatus(), client: (config.get(['mcpGui']) || {}).url || 'http://127.0.0.1:3090/mcp' });
  }
  // GUI Agent 调度配置（开启/模式/频率）
  if (p === '/api/gui/agent/config' && method === 'GET') {
    return sendJSON(res, 200, guiAgent.config());
  }
  if (p === '/api/gui/agent/config' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok:false, error:'需要管理员权限' });
      const cfg = guiAgent.setConfig(body);
      return sendJSON(res, 200, { ok:true, ...cfg });
    } catch (e) {
      return sendJSON(res, 400, { ok:false, error: e.message });
    }
  }
  // GUI Agent：执行任务（vision 模型驱动，仅完全访问权限；遵循调度配置）
  if (p === '/api/gui/agent' && method === 'POST') {
    const body = await readBody(req);
    try {
      if (!permissions.can('guiControl')) return sendJSON(res, 403, { ok:false, error:'需要完全访问(full)权限' });
      const result = await guiAgent.run(body.task || '', { maxSteps: body.maxSteps, mode: body.mode, interval: body.interval });
      return sendJSON(res, 200, result);
    } catch (e) {
      logger.error('GUI Agent 执行失败', { error: e.message });
      return sendJSON(res, 400, { ok:false, error: e.message });
    }
  }

  // ---- OpenAI 兼容 API ----
  if (features.isEnabled('openaiCompat') && p === '/v1/models' && method === 'GET') {
    const g2 = authGate(req);
    if (!g2.ok) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, openaiCompat.listModels());
  }
  if (features.isEnabled('openaiCompat') && p === '/v1/chat/completions' && method === 'POST') {
    const body = await readBody(req);
    const result = await openaiCompat.handleChat(req, body);
    if (result.stream) {
      res.writeHead(result.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      for (const chunk of result.chunks) res.write(chunk);
      res.end();
      return;
    }
    return sendJSON(res, result.status, result.body);
  }

  // ---- SDK (JSON-RPC 2.0) ----
  if (p === '/sdk' && method === 'POST') {
    const g2 = authGate(req);
    if (!g2.ok) return sendJSON(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    try {
      const result = await sdkRpc.handle(body, req);
      return sendJSON(res, 200, result);
    } catch (e) {
      logger.error('SDK RPC 失败', { error: e.message });
      return sendJSON(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
  }

  // ---- Webhook ----
  if (p === '/api/webhook' && method === 'POST') {
    const body = await readBody(req);
    const result = await webhook.handle(body || {}, req);
    return sendJSON(res, result.ok ? 200 : 401, result);
  }
  if (p === '/api/webhook/status' && method === 'GET') {
    return sendJSON(res, 200, webhook.status());
  }

  // ---- 凭据管理 ----
  if (p === '/api/credentials' && method === 'GET') {
    const g2 = authGate(req);
    if (!g2.ok) return sendJSON(res, 401, { error: 'unauthorized' });
    return sendJSON(res, 200, { ok: true, credentials: credentials.list() });
  }
  if (p === '/api/credentials' && method === 'POST') {
    const g2 = authGate(req);
    if (!g2.ok) return sendJSON(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    return sendJSON(res, 200, credentials.set(body.key, body.value));
  }
  if (p === '/api/credentials' && method === 'DELETE') {
    const g2 = authGate(req);
    if (!g2.ok) return sendJSON(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    return sendJSON(res, 200, credentials.remove(body.key));
  }

  // ---- 钩子 ----
  if (p === '/api/hooks/status' && method === 'GET') {
    return sendJSON(res, 200, hooks.status());
  }

  return sendJSON(res, 404, { error: 'not found' });
}

// ---- MCP-GUI（已嵌入主服务，/mcp 路由） ----
function startMcpGuiServer() {
  const c = config.get(['mcpGui']) || {};
  if (c.enabled === false) { logger.info('MCP-GUI 已禁用'); return; }
  logger.info('MCP-GUI 已嵌入主服务', { route: '/mcp', tools: '6' });
}
function mcpGuiStatus() {
  const c = config.get(['mcpGui']) || {};
  return { embedded: true, running: true, route: '/mcp', standalone: c.standalone !== false, standalonePort: c.port || 3090 };
}

// ---- 启动 ----
function start() {
  config.load();
  logger.init();
  native.init();
  cache.init();
  roles.init();
  kb.init();
  risk.init();
  taskQueue.init();
  plugins.init();
  scheduler.init();
  features.init();
  sessionStore.init();
  webhook.init();
  credentials.init();
  hooks.init();
  startMcpGuiServer();

  const serverCfg = { ...(config.get(['server']) || {}) };
  // 命令行参数覆盖：oyuan start --port 8080 --host 0.0.0.0
  const argvPortIdx = process.argv.indexOf('--port');
  const argvHostIdx = process.argv.indexOf('--host');
  if (argvPortIdx > -1 && process.argv[argvPortIdx + 1]) serverCfg.port = Number(process.argv[argvPortIdx + 1]) || serverCfg.port;
  if (argvHostIdx > -1 && process.argv[argvHostIdx + 1]) serverCfg.host = process.argv[argvHostIdx + 1];
  permissions.computeEffective({});

  const dev = process.argv.includes('--dev');
  logger.info('O-yuan 启原 启动中', {
    version: require('../../package.json').version,
    host: serverCfg.host, port: serverCfg.port,
    native: native.isNative(),
    dev
  });

  const srv = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || '/', true);
      if (parsed.pathname === '/mcp' && req.method === 'POST') {
        // MCP-GUI（嵌入主服务）
        mcpHandler(req, res);
      } else if (parsed.pathname === '/mcp/health' && req.method === 'GET') {
        sendJSON(res, 200, mcpHealthInfo());
      } else if (parsed.pathname.startsWith('/api/') || parsed.pathname.startsWith('/v1/') || parsed.pathname === '/sdk') {
        await handleApi(req, res, parsed);
      } else {
        serveStatic(res, parsed.pathname);
      }
    } catch (e) {
      logger.error('请求处理异常', { error: e.message });
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
    }
  });

  srv.listen(serverCfg.port, serverCfg.host, () => {
    logger.info('服务已启动', { url: 'http://' + serverCfg.host + ':' + serverCfg.port });
    console.log('\n==============================================');
    console.log('  O-yuan · 启原 通用智能体');
    console.log('  访问: http://' + serverCfg.host + ':' + serverCfg.port);
    console.log('  权限: ' + permissions.describe());
    console.log('  原生加速: ' + (native.isNative() ? '已启用 (C++)' : '降级为 JS 实现'));
    console.log('==============================================\n');
  });

  srv.on('error', (e) => {
    logger.error('服务启动失败', { error: e.message });
    console.error('服务启动失败: ' + e.message);
    process.exit(1);
  });
}

module.exports = { start };

// 直接运行
if (require.main === module) start();
