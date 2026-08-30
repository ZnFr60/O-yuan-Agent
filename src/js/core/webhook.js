// webhook.js - Webhook 入口（采用业界通用做法：webhook）
// 外部系统通过 POST /api/webhook 触发 O-yuan 处理。
// 每条规则(id/kind)把投递内容(delivery)构造为消息，交给 agent 处理（复用 chat-service）。
// 支持规则注册、投递记录、简单鉴权(可选 secret)。
'use strict';
const config = require('./config');
const logger = require('./logger');
const chatService = require('../services/chat-service');

// 内置规则：把投递内容作为消息发给 agent
const BUILTIN_RULES = {
  default: {
    id: 'default',
    kind: 'message',
    description: '把 webhook 投递的 message 字段作为用户消息发给 agent 处理',
    buildMessage: (delivery) => {
      const m = delivery.message || delivery.text || delivery.body || '';
      return '【Webhook 投递】来源:' + delivery.source + '\n内容: ' + String(m).slice(0, 3000);
    }
  }
};

class WebhookRuntime {
  constructor() {
    this.rules = new Map(); // id -> rule
    this.secret = '';       // 可选鉴权 secret
    this.deliveries = [];   // 最近投递记录
    this.maxDeliveries = 50;
    this.enabled = true;
  }

  init() {
    const c = config.get(['webhook']) || {};
    this.secret = c.secret || '';
    this.enabled = c.enabled !== false;
    for (const [id, rule] of Object.entries(BUILTIN_RULES)) {
      this.rules.set(id, { ...rule });
    }
    // 用户自定义规则
    if (Array.isArray(c.rules)) {
      for (const r of c.rules) {
        if (r && r.id) this.rules.set(r.id, { kind: r.kind || 'message', description: r.description || '', buildMessage: (d) => r.messageTemplate || String(d.message || d.body || '') });
      }
    }
  }

  // 校验投递鉴权（header: X-Webhook-Secret 或 body.secret）
  authorize(req, body) {
    if (!this.enabled) return { ok: false, error: 'webhook 已禁用' };
    if (!this.secret) return { ok: true }; // 未设 secret 不鉴权（本地默认）
    const header = (req.headers['x-webhook-secret'] || '');
    if (header === this.secret) return { ok: true };
    if (body && body.secret === this.secret) return { ok: true };
    return { ok: false, error: '无效的 webhook secret' };
  }

  // 处理一次投递：验证 → 构造消息 → 交给 agent → 记录
  async handle(delivery, req) {
    const d = {
      kind: String(delivery.kind || 'message'),
      source: String(delivery.source || 'unknown'),
      deliveryId: String(delivery.deliveryId || ('wh-' + Date.now())),
      receivedAt: Date.now(),
      ...delivery
    };
    const authRes = this.authorize(req, delivery);
    if (!authRes.ok) return { ok: false, error: authRes.error, deliveryId: d.deliveryId };
    // 找规则
    const rule = this.rules.get(d.kind) || this.rules.get('default');
    if (!rule) return { ok: false, error: '没有匹配的 webhook 规则: ' + d.kind };
    // 构造消息
    let message;
    try { message = rule.buildMessage(d); } catch (e) { message = String(d.message || d.body || ''); }
    logger.info('Webhook 投递', { deliveryId: d.deliveryId, kind: d.kind, source: d.source, msgLen: String(message).length });
    // 交给 agent 处理（后台执行，不阻塞响应）
    const processing = (async () => {
      try {
        const result = await chatService.handleMessage(message, { sessionId: 'webhook-' + d.deliveryId });
        return result.final ? result.final.text : (result.text || '');
      } catch (e) {
        logger.warn('Webhook 处理失败', { deliveryId: d.deliveryId, error: e.message });
        return null;
      }
    })();
    // 记录投递
    this.deliveries.unshift({ deliveryId: d.deliveryId, kind: d.kind, source: d.source, receivedAt: d.receivedAt, pending: true });
    if (this.deliveries.length > this.maxDeliveries) this.deliveries.length = this.maxDeliveries;
    // 立即返回，处理异步进行
    return { ok: true, deliveryId: d.deliveryId, processing: true };
  }

  status() {
    return {
      enabled: this.enabled,
      hasSecret: !!this.secret,
      rules: Array.from(this.rules.entries()).map(([id, r]) => ({ id, kind: r.kind, description: r.description || '' })),
      deliveries: this.deliveries
    };
  }
}

module.exports = new WebhookRuntime();
