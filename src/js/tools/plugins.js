// plugins.js - 插件生命周期钩子
// 预留钩子：任务前置拦截 / 缓存回调 / 合议完成回调 / 命令执行前置拦截
// 插件文件：plugins/*.js，导出 hooks 对象；插件继承全局权限约束。
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

const HOOKS = [
  'onBeforeTask',     // (task) => task | null（返回 null 表示拦截）
  'onCacheWrite',     // (key, value) => void
  'onDeliberationDone',// (result) => void
  'onBeforeCommand',  // (cmd) => cmd | null（返回 null 表示拦截）
  'onBeforeChat'      // (message) => message | null
];

class PluginManager {
  constructor() {
    this.plugins = [];
    this.dir = null;
    this.enabled = false;
  }

  init() {
    const c = config.get(['plugins']) || {};
    this.enabled = c.enabled === true;
    this.dir = config.resolveDir(c.dir || 'plugins');
    if (!this.enabled) return;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.dir)) return;
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      try {
        const mod = require(path.join(this.dir, f));
        if (mod && typeof mod === 'object') this.plugins.push({ name: f, hooks: mod });
        logger.info('插件已加载', { file: f });
      } catch (e) {
        logger.warn('插件加载失败', { file: f, error: e.message });
      }
    }
  }

  async runHook(hook, payload) {
    if (!this.enabled) return payload;
    for (const p of this.plugins) {
      if (typeof p.hooks[hook] === 'function') {
        try {
          const res = await p.hooks[hook](payload);
          if (res === null) return null; // 拦截
          payload = res;
        } catch (e) {
          logger.warn('插件钩子执行异常', { hook, plugin: p.name, error: e.message });
        }
      }
    }
    return payload;
  }

  // 插件也受权限约束：插件所在能力
  can(perm) { return permissions.can(perm); }
}

module.exports = new PluginManager();
