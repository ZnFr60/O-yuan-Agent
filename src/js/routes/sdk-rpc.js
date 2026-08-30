// sdk-rpc.js - JSON-RPC 2.0 服务端（采用业界通用做法：SDK）
// 外部程序可通过 POST /sdk 用 JSON-RPC 2.0 协议与 O-yuan 交互。
// 支持方法: ping / chat / status / tools.list / session.list
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const scheduler = require('../deliberation/scheduler');
const sessionStore = require('../core/session');
const toolRunner = require('../tools/tool-runner');

// JSON-RPC 2.0 错误码
const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

class SdkRpc {
  // 处理一个 JSON-RPC 2.0 请求（支持单请求或批量数组），返回响应对象或响应数组
  async handle(body, req) {
    if (Array.isArray(body)) {
      const results = [];
      for (const b of body) results.push(await this._handleOne(b, req));
      return results;
    }
    return this._handleOne(body, req);
  }

  async _handleOne(body, req) {
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return { jsonrpc: '2.0', id: (body && body.id != null) ? body.id : null, error: { code: ERR.INVALID_REQUEST, message: 'Invalid Request' } };
    }
    const id = body.id != null ? body.id : null;
    const params = (body.params != null && typeof body.params === 'object') ? body.params : {};
    try {
      const result = await this._dispatch(body.method, params, req);
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      logger.warn('SDK RPC 方法错误', { method: body.method, error: e.message });
      return { jsonrpc: '2.0', id, error: { code: ERR.INTERNAL, message: e.message } };
    }
  }

  async _dispatch(method, params, req) {
    switch (method) {
      case 'ping': return { pong: true, time: Date.now(), version: require('../../../package.json').version };
      case 'chat': {
        const msg = String(params.message || '');
        if (!msg) throw new Error('message 不能为空');
        const chatService = require('../services/chat-service');
        const sessionId = params.sessionId || 'default';
        const result = await chatService.handleMessage(msg, { ...params, sessionId });
        return { ok: true, text: result.final ? result.final.text : (result.text || ''), sessionId, strategy: result.final ? result.final.strategy : result.strategy };
      }
      case 'status': {
        const serverCfg = config.get(['server']) || {};
        const canDeliberate = scheduler.canDeliberate();
        return {
          ok: true,
          native: require('../core/native').isNative(),
          models: scheduler.effectiveApiCount(),
          canDeliberate,
          permissions: require('../core/permissions').effective,
          sessionCount: sessionStore.stats().activeSessions,
          port: serverCfg.port,
          version: require('../../../package.json').version
        };
      }
      case 'tools.list': {
        const list = Object.keys(toolRunner.registry).map(name => ({
          name,
          needsPermission: toolRunner.registry[name].needsPermission,
          desc: toolRunner.registry[name].desc
        }));
        return { ok: true, tools: list };
      }
      case 'session.list': {
        return { ok: true, groups: sessionStore.list() };
      }
      default:
        return { error: { code: ERR.METHOD_NOT_FOUND, message: 'Method not found: ' + method } };
    }
  }
}

module.exports = new SdkRpc();
