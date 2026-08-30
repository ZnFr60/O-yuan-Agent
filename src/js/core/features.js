// features.js - 模块化功能开关（集中管理）
// 每个非核心功能都可独立开关，使用者自行调节；关闭的功能不执行任何逻辑。
'use strict';
const config = require('./config');
const logger = require('./logger');

// 功能注册表：id -> {label, description, default, group}
const REGISTRY = {
  deliberation: { label: '多模型合议', group: 'core', default: true, desc: '多模型并行调用与合议调度' },
  cache:        { label: '全局缓存', group: 'core', default: true, desc: 'LRU+TTL 请求缓存' },
  rag:          { label: '知识库 RAG', group: 'knowledge', default: true, desc: '私有知识库检索增强' },
  search:       { label: '联网搜索', group: 'knowledge', default: false, desc: '按需获取外部实时信息' },
  roles:        { label: '全局角色', group: 'persona', default: true, desc: 'MD 角色档案持久生效' },
  permissions:  { label: '三级权限', group: 'security', default: true, desc: '系统执行权限控制' },
  lanAuth:      { label: '局域网鉴权', group: 'security', default: true, desc: '局域网访问密码鉴权' },
  risk:         { label: '消费风控', group: 'economy', default: true, desc: 'Token 上限与成本预估' },
  taskQueue:    { label: '异步任务队列', group: 'economy', default: true, desc: '并发控制与排队' },
  plugins:      { label: '插件钩子', group: 'ext', default: false, desc: '生命周期钩子扩展' },
  openaiCompat: { label: 'OpenAI 兼容 API', group: 'ext', default: true, desc: '/v1/chat/completions 出口' },
  sessionMemory:{ label: '多轮会话记忆', group: 'core', default: true, desc: '上下文历史注入,支持多轮对话' },
  toolCalling:  { label: '工具调用链', group: 'ext', default: true, desc: '调用工具并将结果回填给模型' },
  customBg:     { label: '自定义聊天背景', group: 'ui', default: true, desc: '背景图片/透明度/模糊' },
  codeHighlight:{ label: '代码块高亮', group: 'ui', default: true, desc: '消息内代码语法高亮' },
  streaming:    { label: '流式输出', group: 'ui', default: false, desc: 'SSE 流式回复' }
};

class FeatureManager {
  constructor() { this.overrides = {}; }

  init() {
    const c = config.get(['features']) || {};
    this.overrides = c.enabled ? c : {};
    if (c.enabled && c.enabled.length) this.overrides = { enabled: c.enabled, disabled: c.disabled || [] };
  }

  isEnabled(id) {
    const reg = REGISTRY[id];
    if (!reg) return true;
    const o = this.overrides;
    if (o.enabled && Array.isArray(o.enabled)) {
      if (o.enabled.includes(id)) return true;
      if (o.enabled.length > 0 && !o.enabled.includes(id) && reg.group !== 'core') return false;
    }
    if (o.disabled && Array.isArray(o.disabled) && o.disabled.includes(id)) return false;
    // 未显式配置时使用默认值
    const cfgVal = config.get(['features', id]);
    if (cfgVal != null) return !!cfgVal;
    return reg.default;
  }

  all() {
    return Object.entries(REGISTRY).map(([id, r]) => ({ id, ...r, enabled: this.isEnabled(id) }));
  }

  setEnabled(id, v) {
    const reg = REGISTRY[id];
    if (!reg) throw new Error('未知功能: ' + id);
    config.set(['features', id], !!v);
    logger.info('功能开关变更', { id, enabled: !!v });
    return !!v;
  }

  group(name) { return this.all().filter((f) => f.group === name); }
  groups() {
    const g = {};
    for (const f of this.all()) { (g[f.group] = g[f.group] || []).push(f); }
    return g;
  }
}

module.exports = new FeatureManager();
module.exports.REGISTRY = REGISTRY;
