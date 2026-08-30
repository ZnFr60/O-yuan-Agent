// hooks.js - 钩子系统（采用业界通用做法：hooks）
// 在关键事件点（工具调用前/后、消息前后等）触发外部钩子（命令/脚本）或内部回调。
// 钩子可拦截/修改/记录行为，是扩展 O-yuan 行为的通用机制。
// 配置钩子（config 的 hooks 字段）:
//   { event: "tool:before", command: "node scripts/hook.js", args: ["{tool}"] }
// 支持占位符: {tool} {message} {sessionId} {args} {result}
'use strict';
const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

// 支持的事件点
const EVENTS = [
  'session:start', 'session:end',        // 会话开始/结束
  'message:before', 'message:after',     // 用户消息处理前/后
  'tool:before', 'tool:after'            // 工具调用前/后
];

class HookRuntime {
  constructor() {
    this.hooks = [];
    this.hookMap = {};  // event -> [hooks]
  }

  init() {
    const c = config.get(['hooks']) || {};
    const list = Array.isArray(c.hooks) ? c.hooks : [];
    for (const h of list) {
      if (h && EVENTS.includes(h.event)) this.register(h);
    }
    logger.info('钩子系统初始化', { count: list.length });
  }

  // 注册一个钩子
  register(hook) {
    if (!hook.event || !EVENTS.includes(hook.event)) return { ok: false, error: '未知事件: ' + hook.event };
    const h = {
      event: hook.event,
      command: hook.command || null,
      args: hook.args || [],
      callback: hook.callback || null, // 内部回调（程序注入，不走命令）
      timeout: hook.timeout || 10000,
      enabled: hook.enabled !== false
    };
    this.hooks.push(h);
    if (!this.hookMap[h.event]) this.hookMap[h.event] = [];
    this.hookMap[h.event].push(h);
    return { ok: true, event: h.event };
  }

  // 注册内部回调钩子（编程式）
  on(event, callback) {
    this.register({ event, callback });
    return () => { this.hooks = this.hooks.filter(h => !(h.callback === callback && h.event === event)); };
  }

  has(event) { return !!(this.hookMap[event] && this.hookMap[event].length); }

  // 触发某事件的钩子。ctx 是占位符值。返回 { blocked, data }（blocked=true 表示某钩子要求拦截）
  async trigger(event, ctx = {}) {
    const hooks = this.hookMap[event] || [];
    if (!hooks.length) return { blocked: false, data: ctx };
    logger.info('钩子触发', { event, count: hooks.length });
    let blocked = false;
    for (const h of hooks) {
      if (!h.enabled) continue;
      const contextStr = this._buildArgs(h, { ...ctx, event });
      try {
        // 内部回调
        if (h.callback) {
          const r = await h.callback({ event, ctx, args: contextStr });
          if (r && r.block) { blocked = true; break; }
          if (r && r.data) ctx = { ...ctx, ...r.data };
        }
        // 外部命令
        else if (h.command) {
          const out = await this._exec(h, contextStr);
          if (out && out.isError === true) blocked = true;
        }
      } catch (e) {
        logger.warn('钩子执行失败', { event, error: e.message });
      }
    }
    return { blocked, data: ctx };
  }

  // 构建命令参数（替换占位符）
  _buildArgs(h, ctx) {
    return (h.args || []).map((a) => {
      return String(a)
        .replace(/{tool}/g, ctx.tool || '')
        .replace(/{message}/g, String(ctx.message || '').slice(0, 200))
        .replace(/{sessionId}/g, ctx.sessionId || '')
        .replace(/{event}/g, ctx.event || '');
    });
  }

  // 执行外部命令（超时控制），不阻塞主流程超时上限
  _exec(h, args) {
    return new Promise((resolve) => {
      const proc = execFile(h.command, args, { timeout: h.timeout, windowsHide: true }, (error) => {
        if (error) {
          logger.warn('钩子命令返回错误', { command: h.command, code: error.code });
          resolve({ isError: true, code: error.code });
        } else {
          resolve({ isError: false });
        }
      });
      proc.on('error', (e) => resolve({ isError: true, code: 'spawn:' + e.code }));
    });
  }

  status() {
    return {
      events: EVENTS,
      registered: this.hooks.map((h) => ({ event: h.event, command: h.command, hasCallback: !!h.callback, enabled: h.enabled }))
    };
  }
}

module.exports = new HookRuntime();
