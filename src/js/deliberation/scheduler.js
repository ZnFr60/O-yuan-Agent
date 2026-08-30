// scheduler.js - 多模型合议调度器
// 四种模式：fast(快速返回) / equal(均等投票) / weighted(加权投票) / deep(深度二次汇总合议)
// 思考深度控制：native(映射 temperature/top_p) 或 prompt_override(推理约束前缀注入)
// 容错：模型连续报错达阈值 -> 临时黑名单，本轮不再调度。
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const cache = require('../core/cache');
const provider = require('./provider');
const plugins = require('../tools/plugins');
const features = require('../core/features');
const { profileFor } = require('./model-profiles');

// think_level(0-10) -> temperature/top_p 映射
function mapThinkToParams(level) {
  // level 越低越确定(低温度)，越高越发散(高温度)
  const t = 0.1 + (level / 10) * 0.9;   // 0.1 ~ 1.0
  const tp = Math.min(1.0, 0.5 + (level / 10) * 0.5); // 0.5 ~ 1.0
  return { temperature: Number(t.toFixed(2)), topP: Number(tp.toFixed(2)) };
}

// prompt_override 模式：根据 think_level 生成推理约束前缀
function buildThinkPrefix(level) {
  if (level <= 2) return '请直接给出简洁、确定、不含多余推理的最终答案。';
  if (level <= 5) return '请先进行简要推理再给出答案，控制推理篇幅。';
  if (level <= 8) return '请进行充分的多步推理，展示思考过程，再给出结论。';
  return '请进行极其深入的批判性多角度推理，穷举可能，最后给出结论并说明不确定性。';
}

class DeliberationScheduler {
  constructor() {
    this.blacklist = new Map(); // modelId -> failCount
    this.faultThreshold = 3;
    this.mode = 'weighted';
    this.confirmCallback = null;
  }

  init() {
    const c = config.get(['deliberation']) || {};
    this.mode = c.mode || 'weighted';
    this.faultThreshold = c.faultThreshold || 3;
  }

  getModels() {
    return (config.get(['models']) || []).filter((m) => m.enabled !== false);
  }

  // 有效 API 数量：启用 且 已配置 apiKey 的模型（决定是否可启用合议）
  effectiveApiCount() {
    return this.getModels().filter((m) => m.apiKey && String(m.apiKey).length > 0 && String(m.apiKey) !== '***').length;
  }

  // 是否可启用合议（≥2 个有效 API 才允许）
  canDeliberate() {
    return this.effectiveApiCount() >= 2;
  }

  // 计算本轮参与模型（排除黑名单）
  eligibleModels() {
    return this.getModels().filter((m) => {
      const fail = this.blacklist.get(m.id) || 0;
      return fail < this.faultThreshold;
    });
  }

  // 获取主模型（老大）：标记为 primary 的模型，用于合议协调和调度
  getPrimaryModel() {
    const eligible = this.eligibleModels();
    // 优先找显式标记为 primary 的
    const primary = eligible.find((m) => m.primary === true);
    if (primary) return primary;
    // 回退：权重最高的
    if (eligible.length) {
      return [...eligible].sort((a, b) => (b.weight || 1) - (a.weight || 1))[0];
    }
    return null;
  }

  recordFailure(modelId) {
    const cur = (this.blacklist.get(modelId) || 0) + 1;
    this.blacklist.set(modelId, cur);
    logger.warn('模型故障计数', { modelId, count: cur });
    if (cur >= this.faultThreshold) logger.warn('模型进入临时黑名单', { modelId });
  }

  recordSuccess(modelId) {
    if (this.blacklist.has(modelId)) this.blacklist.delete(modelId);
  }

  // 组装某模型的请求消息：注入角色人设 + 思考控制 + 知识库片段 + 搜索上下文
  buildMessages(basePrompt, userMsg, modelCfg, rolePrompt, kbSnippets, searchResults, thinkLevel) {
    const msgs = [];
    let system = '';
    if (rolePrompt) system += rolePrompt + '\n\n';
    const thinkMode = modelCfg.think_control_mode || config.get(['think', 'controlMode']) || 'native';
    if (thinkMode === 'prompt_override') {
      system += buildThinkPrefix(thinkLevel) + '\n\n';
    }
    if (kbSnippets && kbSnippets.length) {
      system += '[知识库参考片段]\n' + kbSnippets.map((s, i) => (i + 1) + '. ' + s.snippet).join('\n') + '\n\n';
    }
    if (searchResults && searchResults.length) {
      system += '[联网搜索信息]\n' + searchResults.map((s, i) => (i + 1) + '. ' + s.title + ' - ' + s.url + ' ' + (s.snippet||'')).join('\n') + '\n\n';
    }
    if (system.trim()) msgs.push({ role: 'system', content: system.trim() });
    if (basePrompt) msgs.push({ role: 'system', content: basePrompt });
    msgs.push({ role: 'user', content: userMsg });
    return msgs;
  }

  // 思考参数（结合主流模型档案校准：clamp 温度到模型安全范围，固定温度模型忽略）
  thinkParams(modelCfg, thinkLevel) {
    const mode = modelCfg.think_control_mode || config.get(['think', 'controlMode']) || 'native';
    let params;
    if (mode === 'native') params = mapThinkToParams(thinkLevel);
    else params = { temperature: 0.7, topP: 0.9 }; // prompt_override 模式用中性参数

    // 模型档案校准
    const profile = profileFor(modelCfg.model || modelCfg.id);
    if (profile) {
      if (profile.fixedTemp) {
        params.temperature = profile.tempRange[0];
        params.topP = 1.0;
      } else if (profile.tempRange) {
        params.temperature = Math.min(Math.max(params.temperature, profile.tempRange[0]), profile.tempRange[1]);
      }
      // 利用档案的默认 max_tokens 上限
      if (params.maxTokens == null && profile.maxTokens) params.maxTokens = profile.maxTokens;
    }
    return params;
  }

  // 单模型调用
  async callModel(modelCfg, messages, thinkLevel) {
    const p = this.thinkParams(modelCfg, thinkLevel);
    const profile = profileFor(modelCfg.model || modelCfg.id);
    const maxTokens = Math.min(modelCfg.maxTokens || (profile && profile.maxTokens) || 2048,
                               (profile && profile.maxTokens) || (modelCfg.maxTokens || 2048));
    const res = await provider.call(modelCfg, messages, {
      temperature: p.temperature,
      topP: p.topP,
      timeoutMs: modelCfg.timeoutMs,
      maxTokens
    });
    this.recordSuccess(modelCfg.id);
    return res;
  }

  // 四种合议模式执行
  async deliberate({ basePrompt, userMsg, rolePrompt, kbSnippets, searchResults, thinkLevel, skipCache, roleId }) {
    const eligible = this.eligibleModels();
    if (!eligible.length) {
      throw new Error('没有可用模型（可能全部进入故障黑名单或未配置）');
    }
    // 有效API检测：<2 个有效 Key 时强制单模型直答（合议自动降级）
    const singleModel = !this.canDeliberate() || eligible.length < 2;
    if (singleModel) {
      logger.info('合议降级：有效API<2，使用单模型直答', { count: this.effectiveApiCount(), eligible: eligible.length });
      const m = eligible[0];
      const msgs = this.buildMessages(basePrompt, userMsg, m, rolePrompt, kbSnippets, searchResults, thinkLevel);
      const p = this.thinkParams(m, thinkLevel);
      const res = await provider.call(m, msgs, { temperature: p.temperature, topP: p.topP, timeoutMs: m.timeoutMs, maxTokens: m.maxTokens });
      this.recordSuccess(m.id);
      const out = {
        final: { text: res.content, strategy: 'single', contributors: [m.id] },
        results: [{ modelId: m.id, weight: m.weight || 1, content: res.content, ok: true }],
        mode: 'single',
        fromCache: false,
        singleModel: true
      };
      try { await plugins.runHook('onDeliberationDone', out); } catch (e) {}
      return out;
    }

    // 尝试缓存（功能开关：缓存模块可关闭）
    const cacheEnabled = features.isEnabled('cache') && !skipCache;
    const cacheKey = cacheEnabled ? cache.buildKey({
      input: userMsg, role: roleId || rolePrompt || '',
      thinkLevel, kbFragments: (kbSnippets||[]).map(s=>s.snippet),
      deliberationCfg: this.mode + ':' + eligible.map(m=>m.id+':'+m.weight).join(',')
    }) : null;
    if (cacheEnabled && cache.shouldUse(cacheKey)) {
      cache.remember(cacheKey);
      const hit = cache.get(cacheKey);
      if (hit) {
        logger.info('缓存命中', { key: cacheKey, fuzzy: cache.stats.fuzzyHit });
        return { ...hit, fromCache: true, key: cacheKey };
      }
    }

    // 并行调用各模型
    const tasks = eligible.map(async (m) => {
      const msgs = this.buildMessages(basePrompt, userMsg, m, rolePrompt, kbSnippets, searchResults, thinkLevel);
      try {
        const res = await this.callModel(m, msgs, thinkLevel);
        return { modelId: m.id, weight: m.weight || 1, content: res.content, usage: res.usage, ok: true };
      } catch (e) {
        this.recordFailure(m.id);
        return { modelId: m.id, weight: m.weight || 1, error: e.message, ok: false };
      }
    });

    let results;
    try {
      results = await Promise.all(tasks);
    } catch (e) {
      results = eligible.map((m) => ({ modelId: m.id, weight: m.weight||1, error: e.message, ok: false }));
    }

    const okResults = results.filter((r) => r.ok);
    if (!okResults.length) {
      const first = results[0];
      const err = new Error('所有模型均调用失败: ' + (first && first.error || '未知错误'));
      throw err;
    }

    // 执行合议策略
    const final = await this._aggregate(okResults, { basePrompt, userMsg, rolePrompt, kbSnippets, searchResults, thinkLevel });

    const out = { final, results, mode: this.mode, fromCache: false, key: cacheKey };
    // 插件钩子
    try { await plugins.runHook('onDeliberationDone', out); } catch (e) {}
    // 写缓存
    if (cacheEnabled && cache.shouldUse(cacheKey)) {
      cache.set(cacheKey, { final, results: results.map(r=>({modelId:r.modelId, ok:r.ok})), mode: this.mode });
      try { await plugins.runHook('onCacheWrite', { key: cacheKey }); } catch (e) {}
    }
    return out;
  }

  async _aggregate(okResults, ctx) {
    const mode = this.mode;
    const primary = this.getPrimaryModel();
    if (mode === 'fast') {
      // 快速返回：优先主模型，否则取第一个成功的
      if (primary) {
        const pResult = okResults.find((r) => r.modelId === primary.id);
        if (pResult) return { text: pResult.content, strategy: 'fast-primary', contributors: [primary.id] };
      }
      return { text: okResults[0].content, strategy: 'fast', contributors: [okResults[0].modelId] };
    }
    if (mode === 'equal') {
      // 均等投票：众数？简单做法：长度最短且非空的作为共识（去重后）
      return { text: this._plurality(okResults, false), strategy: 'equal', contributors: okResults.map(r=>r.modelId) };
    }
    if (mode === 'weighted') {
      // 加权投票：优先主模型，否则按权重最高的作为主答案
      if (primary) {
        const pResult = okResults.find((r) => r.modelId === primary.id);
        if (pResult) {
          const sorted = [...okResults].sort((a, b) => (b.weight||1) - (a.weight||1));
          return { text: pResult.content, strategy: 'weighted-primary', contributors: sorted.map(r=>r.modelId), primary: primary.id };
        }
      }
      const sorted = [...okResults].sort((a, b) => (b.weight||1) - (a.weight||1));
      return { text: sorted[0].content, strategy: 'weighted', contributors: sorted.map(r=>r.modelId) };
    }
    if (mode === 'deep') {
      // 深度二次汇总：优先用主模型对多方答案做汇总
      return this._deepSummary(okResults, ctx, primary);
    }
    return { text: okResults[0].content, strategy: 'fallback', contributors: [okResults[0].modelId] };
  }

  _plurality(results, weighted) {
    // 简单共识：返回最长的完整答案（作为稳定的选择），避免空/错误
    const valid = results.filter((r) => r.content && r.content.trim());
    if (!valid.length) return results[0].content;
    valid.sort((a, b) => b.content.length - a.content.length);
    return valid[0].content;
  }

  async _deepSummary(okResults, ctx, primary = null) {
    // 优先用主模型做汇总，否则用权重最高的
    const coordinator = primary || [...okResults].sort((a, b) => (b.weight||1) - (a.weight||1))[0];
    const modelCfg = this.getModels().find((m) => m.id === coordinator.modelId);
    if (!modelCfg) return { text: coordinator.content, strategy: 'deep-fallback', contributors: [coordinator.modelId] };
    const others = okResults.filter((r) => r.modelId !== coordinator.modelId);
    let prompt = '你是合议协调者（主模型），负责综合多个模型对同一问题的回答，给出一个最终的一致答案。\n\n问题：' + ctx.userMsg + '\n\n';
    okResults.forEach((r, i) => {
      const isPrimary = r.modelId === coordinator.modelId ? '（主模型）' : '';
      prompt += '\n--- 回答 ' + (i+1) + ' (' + r.modelId + isPrimary + ') ---\n' + r.content;
    });
    prompt += '\n\n请给出最终答案，并简要说明如何综合了各方观点。';
    try {
      const res = await this.callModel(modelCfg, [{ role: 'user', content: prompt }], ctx.thinkLevel);
      return { text: res.content, strategy: 'deep', contributors: okResults.map(r=>r.modelId), summaryModel: modelCfg.id, primary: coordinator.modelId };
    } catch (e) {
      logger.warn('深度汇总失败，回退主答案', { error: e.message });
      return { text: coordinator.content, strategy: 'deep-fallback', contributors: okResults.map(r=>r.modelId), primary: coordinator.modelId };
    }
  }

  // 重置故障黑名单（供管理接口调用）
  resetBlacklist() { this.blacklist.clear(); }
  blacklistStatus() { return Array.from(this.blacklist.entries()).map(([id, c]) => ({ id, failCount: c })); }
}

module.exports = new DeliberationScheduler();
