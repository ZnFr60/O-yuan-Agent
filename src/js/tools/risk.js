// risk.js - API 消费风控（单日 token 上限 / 成本预估确认 / 消费统计看板）
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const logger = require('../core/logger');

class RiskManager {
  constructor() {
    this.dailyLimit = 1000000;
    this.confirmThreshold = 0.02;
    this.state = { date: '', tokensUsed: 0, cost: 0, requests: 0, byModel: {} };
    this.stateFile = null;
  }

  init() {
    const c = config.get(['risk']) || {};
    this.dailyLimit = c.dailyTokenLimit || 1000000;
    this.confirmThreshold = c.confirmCostThreshold != null ? c.confirmCostThreshold : 0.02;
    this.stateFile = path.join(config.root(), 'config', '.risk-state.json');
    this.loadState();
  }

  loadState() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (fs.existsSync(this.stateFile)) {
        const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (s.date === today) this.state = s;
        else this.state = { date: today, tokensUsed: 0, cost: 0, requests: 0, byModel: {} };
      } else {
        this.state = { date: today, tokensUsed: 0, cost: 0, requests: 0, byModel: {} };
      }
    } catch (e) {
      this.state = { date: today, tokensUsed: 0, cost: 0, requests: 0, byModel: {} };
    }
  }

  persist() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8'); }
    catch (e) { logger.warn('风控状态写入失败', { error: e.message }); }
  }

  // 检查是否超限
  checkLimit(extraTokens = 0) {
    if (this.state.tokensUsed + extraTokens > this.dailyLimit) {
      throw new Error('已达今日 token 消费上限 (' + this.state.tokensUsed + '/' + this.dailyLimit + ')');
    }
    return true;
  }

  // 估算成本（简化：每 1K token 按模型单价，缺省 0.002 美元）
  estimateCost(tokens, modelId) {
    const model = (config.get(['models']) || []).find((m) => m.id === modelId);
    const rate = (model && model.pricePer1k) || 0.002;
    return (tokens / 1000) * rate;
  }

  // 预估成本是否需要用户确认
  needsConfirm(tokens, modelId) {
    return this.estimateCost(tokens, modelId) >= this.confirmThreshold;
  }

  record({ tokens, modelId, cost }) {
    this.state.tokensUsed += tokens;
    this.state.requests++;
    if (cost != null) this.state.cost += cost;
    if (modelId) {
      const m = this.state.byModel[modelId] || { tokens: 0, requests: 0 };
      m.tokens += tokens;
      m.requests++;
      this.state.byModel[modelId] = m;
    }
    this.persist();
  }

  snapshot() {
    return {
      dailyLimit: this.dailyLimit,
      confirmThreshold: this.confirmThreshold,
      ...this.state,
      remaining: Math.max(0, this.dailyLimit - this.state.tokensUsed)
    };
  }
}

module.exports = new RiskManager();
