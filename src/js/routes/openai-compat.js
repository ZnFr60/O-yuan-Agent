// openai-compat.js - OpenAI 兼容 API 出口
// 提供 /v1/chat/completions 与 /v1/models 端点，使 Conclave 可被任意
// OpenAI SDK / 第三方工具以标准格式调用（复用内部合议/缓存/角色/RAG 全链路）。
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const permissions = require('../core/permissions');
const roles = require('../core/roles');
const kb = require('../core/kb');
const scheduler = require('../deliberation/scheduler');
const cache = require('../core/cache');
const risk = require('../tools/risk');

// 开发者导向：OpenAI 兼容 API 无鉴权，直接放行。
function authCompat(req) {
  return { ok: true, loopback: true };
}

// 从 OpenAI messages 提取最新用户内容与系统提示
function parseMessages(messages) {
  let userMsg = '';
  let basePrompt = '';
  const last = messages && messages.length ? messages[messages.length - 1] : null;
  if (last && last.role === 'user') userMsg = last.content || '';
  else if (Array.isArray(messages)) {
    // 取最后一个非空 user 内容
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userMsg = messages[i].content || ''; break; }
    }
  }
  const system = (messages || []).find((m) => m.role === 'system');
  if (system) basePrompt = system.content || '';
  return { userMsg, basePrompt };
}

class OpenAIBridge {
  async handleChat(req, body) {
    const authRes = authCompat(req);
    if (!authRes.ok) return { status: 401, body: { error: { message: 'Invalid API key / unauthorized', type: 'authentication_error' } } };

    const { userMsg, basePrompt } = parseMessages(body.messages);
    if (!userMsg) return { status: 400, body: { error: { message: 'Missing user message', type: 'invalid_request_error' } } };

    // 可选参数
    const requestedModel = body.model || 'conclave';
    const thinkLevel = body.think_level != null ? body.think_level : (config.get(['think','level']) ?? 5);
    const useRag = body.use_rag !== false && config.get(['rag','enabled']);
    const useSearch = body.use_search === true && config.get(['search','enabled']);
    const stream = !!body.stream;

    // RAG
    let kbSnippets = [];
    if (useRag && kb.enabled) {
      try { kbSnippets = await kb.search(userMsg, config.get(['rag','maxRefs'])); } catch (e) { logger.warn('compat RAG fail', { error: e.message }); }
    }
    let searchResults = [];
    if (useSearch) {
      try { const st = require('../tools/search'); searchResults = await st.search(userMsg); } catch (e) {}
    }
    const rolePrompt = roles.enabled && roles.selectedRole ? roles.renderSystemPrompt(roles.selectedRole) : '';

    // 缓存
    const cacheKey = cache.buildKey({
      input: userMsg, role: rolePrompt || '', thinkLevel,
      kbFragments: (kbSnippets||[]).map(s=>s.snippet),
      deliberationCfg: (config.get(['deliberation','mode'])||'weighted') + ':' + (body.model||'conclave')
    });
    let cached = null;
    if (cache.shouldUse(cacheKey)) cached = cache.get(cacheKey);
    if (cached) {
      logger.info('OpenAI兼容: 缓存命中', { key: cacheKey });
      return this._buildCompletion(cached.text, requestedModel, stream, { fromCache: true, strategy: cached.strategy });
    }

    // 风控
    const est = Math.max(500, Math.round((userMsg.length + (rolePrompt?.length||0) + kbSnippets.length*500)/2));
    try { risk.checkLimit(est); } catch (e) { return { status: 429, body: { error: { message: e.message, type: 'rate_limit_exceeded' } } }; }

    // 合议
    try {
      const result = await scheduler.deliberate({
        basePrompt, userMsg, rolePrompt, kbSnippets, searchResults, thinkLevel
      });
      risk.record({ tokens: est, modelId: result.results?.[0]?.modelId, cost: risk.estimateCost(est, result.results?.[0]?.modelId) });
      if (cache.shouldUse(cacheKey)) cache.set(cacheKey, { text: result.final.text, strategy: result.final.strategy });
      return this._buildCompletion(result.final.text, requestedModel, stream, {
        fromCache: false, strategy: result.final.strategy,
        contributors: result.final.contributors
      });
    } catch (e) {
      logger.error('OpenAI兼容合议失败', { error: e.message });
      return { status: 500, body: { error: { message: e.message, type: 'server_error' } } };
    }
  }

  _buildCompletion(text, model, stream, extra = {}) {
    const id = 'chatcmpl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const usage = { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 2), total_tokens: Math.ceil(text.length / 2) };
    if (stream) {
      return { status: 200, stream: true, chunks: [
        'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n',
        'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
        'data: [DONE]\n\n'
      ] };
    }
    const body = {
      id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage, ...(extra.fromCache ? { _meta: { fromCache: true } } : {})
    };
    return { status: 200, body };
  }

  listModels() {
    const models = config.get(['models']) || [];
    return {
      object: 'list',
      data: models.map((m) => ({ id: m.id + ':' + (m.model||''), object: 'model', owned_by: m.id, enabled: m.enabled !== false }))
    };
  }
}

module.exports = new OpenAIBridge();
