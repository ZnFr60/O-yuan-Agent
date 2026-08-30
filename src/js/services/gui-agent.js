// gui-agent.js - GUI Agent（两种调度模式）
// 模式一 interval（定时截图）：按用户设定频率（次/秒，支持小数）定时截图给模型看，模型决策后操作。
//   频率越高，模型响应可能越慢，但任务执行更流畅 —— 取决于模型能力。
// 模式二 auto（自动化）：模型自主决策当下是否需要截图（needScreenshot: true/false）。
// 两模式互斥；都不开启 = GUI 能力关闭。
// 流程：截图(或复用)→vision识别→模型输出操作JSON→执行→(interval:等待到下一频率; auto:模型决定是否再截)→直到完成或达最大步数
'use strict';
const logger = require('../core/logger');
const config = require('../core/config');
const permissions = require('../core/permissions');
const gui = require('../tools/gui-automation');   // 备用：本机直连 pyautogui
const mcp = require('../tools/mcp-client');      // 主路径：通过 MCP 调用 GUI 工具
const scheduler = require('../deliberation/scheduler');
const provider = require('../deliberation/provider');

// 找一个支持 vision 的已启用模型
function visionModel() {
  const models = (config.get(['models']) || []).filter(m => m.enabled !== false && m.vision === true && m.apiKey);
  return models[0] || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class GuiAgent {
  // 读取当前 GUI Agent 调度配置
  config() {
    const c = config.get(['guiAgent']) || {};
    return { enabled: !!c.enabled, mode: c.mode || 'none', interval: c.interval || 1.0, maxSteps: c.maxSteps || 8 };
  }

  // 状态（供前端展示）
  status() {
    const vm = visionModel();
    const cfg = this.config();
    return {
      available: !!vm,
      visionModel: vm ? vm.id : null,
      enabled: cfg.enabled,
      mode: cfg.mode,
      interval: cfg.interval,
      reason: vm ? null : '未配置支持图形识别(vision)的模型（GUI 不强行）',
      active: cfg.enabled && cfg.mode !== 'none'
    };
  }

  // 设置配置：enabled/mode/interval（mode: none|interval|auto，interval 支持小数次/秒）
  setConfig({ enabled, mode, interval }) {
    const c = config.get(['guiAgent']) || {};
    if (mode !== undefined) {
      if (!['none', 'interval', 'auto'].includes(mode)) throw new Error('mode 必须是 none|interval|auto');
      c.mode = mode;
    }
    if (enabled !== undefined) c.enabled = !!enabled;
    if (interval !== undefined) {
      const v = parseFloat(interval);
      if (isNaN(v) || v <= 0 || v > 10) throw new Error('截图频率必须是 0~10 次/秒之间的数字（支持小数，如 0.5 = 每2秒一次）');
      c.interval = v;
    }
    if (c.mode === 'none') c.enabled = false; // 都不开 = GUI 关闭
    config.set(['guiAgent'], c);
    logger.info('GUI Agent 配置更新', { enabled: c.enabled, mode: c.mode, interval: c.interval });
    return c;
  }

  async run(task, opts = {}) {
    if (!permissions.can('guiControl')) {
      throw new Error('GUI Agent 需要"完全访问(full)"权限，当前=' + permissions.effective);
    }
    const vm = visionModel();
    if (!vm) {
      throw new Error('未找到支持图形识别(vision)的模型。请在"API管理"中给模型勾选"支持图形识别"，GUI Agent 才能运行（GUI 不强行）。');
    }
    const cfg = this.config();
    const mode = opts.mode || cfg.mode || 'none';
    const interval = opts.interval != null ? opts.interval : cfg.interval;
    const maxSteps = opts.maxSteps || cfg.maxSteps || 8;

    if (mode === 'none' || !cfg.enabled) {
      throw new Error('GUI Agent 未启用：请先在设置中开启 GUI 能力并选择模式（定时截图 或 自动化）');
    }
    if (mode !== 'interval' && mode !== 'auto') throw new Error('模式必须是 interval(定时截图) 或 auto(自动化)');

    const intervalMs = mode === 'interval' ? Math.max(100, Math.round(1000 / interval)) : null;
    logger.info('GUI Agent 启动', { task, visionModel: vm.id, mode, interval, intervalMs, maxSteps });
    const steps = [];
    // 记录当前屏幕（首次/每步截图）
    let lastShot = null;

    for (let i = 0; i < maxSteps; i++) {
      const step = { step: i + 1, image: null, action: null, done: false, note: '', mode };

      // 决定是否需要截图：
      //  - interval 模式：本步必然截图（按频率）
      //  - auto 模式：由模型上一步的 needScreenshot 决定（首步必截）
      let needShot = true;
      if (mode === 'auto' && i > 0) {
        needShot = !!(steps[i - 1].needScreenshot);
        if (!needShot) step.note = '模型判断无需截图，直接推理/操作';
      }

      if (needShot) {
        const shot = await this._screenshot();
        if (!shot) throw new Error('截图失败');
        lastShot = shot;
        step.image = shot;
        step.note = (step.note ? step.note + '；' : '') + '已截图' + (this._viaMcp ? '(MCP)' : '');
      } else {
        step.image = lastShot; // 复用上次截图（模型说不用截时用旧图辅助）
      }

      // vision 模型决策
      const decision = await this._decide(vm, task, step.image, steps, i, mode);
      if (!decision.ok) throw new Error('模型决策失败: ' + (decision.error || ''));

      step.needScreenshot = decision.needScreenshot === true;

      if (decision.done) {
        step.done = true;
        step.note = decision.summary || '任务完成';
        steps.push(step);
        return { ok: true, done: true, steps, summary: decision.summary || '任务完成', visionModel: vm.id, mode };
      }
      if (!decision.action) {
        step.note = (step.note ? step.note + '；' : '') + '模型未给出操作';
        steps.push(step);
        return { ok: true, done: false, steps, note: '模型未给出操作，提前结束', visionModel: vm.id, mode };
      }

      const act = decision.action;
      step.action = act;
      try {
        await this._execute(act);
        step.note = (step.note ? step.note + '；' : '') + '执行: ' + (act.action || '') + (act.x != null ? '(' + act.x + ',' + act.y + ')' : '') + (act.text ? ' "' + act.text + '"' : '');
        logger.info('GUI Agent 执行', { step: i + 1, action: act.action, mode });
      } catch (e) {
        step.note = (step.note ? step.note + '；' : '') + '执行失败: ' + e.message;
        logger.warn('GUI Agent 动作失败', { step: i + 1, error: e.message });
      }
      steps.push(step);

      // interval 模式：等待到下一截图时刻（频率越小等待越长）
      if (mode === 'interval') await sleep(intervalMs);
      else await sleep(200); // auto 模式短暂停顿
    }
    return { ok: true, done: false, steps, note: '达到最大步数(' + maxSteps + ')未完成', visionModel: vm.id, mode };
  }

  // 用 vision 模型做决策（多模态输入截图）
  async _decide(vm, task, imageB64, priorSteps, stepIdx, mode) {
    const sys = '你是一个 GUI 操作 Agent。你会收到屏幕截图，需要决定下一步操作来完成用户任务。' +
      '输出严格 JSON：{"action":"move|click|type|hotkey|scroll","x":数字,"y":数字,"text":"输入文本","button":"left|right","keys":[...],"done":false,"summary":"说明","needScreenshot":true/false}' +
      '。如果任务已完成，输出 {"done":true,"summary":"完成说明"}。' +
      'needScreenshot: ' + (mode === 'auto' ? 'true 表示你需要再看一次屏幕，false 表示当前信息足够直接操作' : '忽略（定时模式每步自动截图）') + '。' +
      '坐标是屏幕像素坐标（0-1920 x 0-1080）。只输出 JSON，不要其他文字。';
    const userMsg = {
      role: 'user',
      content: [
        { type: 'text', text: '任务: ' + task + (priorSteps.length ? '\n之前已执行步骤: ' + JSON.stringify(priorSteps.map(s => ({ action: s.action, note: s.note }))) : '') + '\n请分析屏幕截图并输出下一步操作JSON。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } }
      ]
    };
    try {
      const p = scheduler.thinkParams(vm, 5);
      // 注意：maxTokens 必须足够大，否则部分 vision 模型会空输出
      const res = await provider.call(vm, [{ role: 'system', content: sys }, userMsg], {
        temperature: p.temperature, topP: p.topP, timeoutMs: 30000, maxTokens: 2048
      });
      let text = String(res.content || '').trim();
      // 空输出重试一次（简化提示，去掉图像，仅文本决策）
      if (!text) {
        logger.warn('GUI Agent 决策空输出，重试（文本模式）', { step: stepIdx });
        const retryRes = await provider.call(vm, [
          { role: 'system', content: '你是GUI操作Agent。基于用户任务和已执行步骤，输出下一步操作JSON。若认为任务可完成，输出 {"done":true,"summary":"..."}。只输出JSON。' },
          { role: 'user', content: '任务: ' + task + (priorSteps.length ? '\n之前步骤: ' + JSON.stringify(priorSteps.map(s => ({ action: s.action, note: s.note }))) : '') }
        ], { temperature: p.temperature, topP: p.topP, timeoutMs: 30000, maxTokens: 2048 });
        text = String(retryRes.content || '').trim();
      }
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) return { ok: false, error: '模型未返回JSON: ' + text.slice(0, 120) };
      return { ok: true, ...JSON.parse(m[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 截图：优先走 MCP（GUI Agent 通过 MCP 调用），MCP 不可用时回退本机直连
  async _screenshot() {
    try {
      if (mcp.url) {
        const r = await mcp.screenshot();
        const img = (r.content || []).find(c => c.type === 'image');
        if (img && img.data) { this._viaMcp = true; return img.data; }
      }
    } catch (e) { logger.warn('MCP 截图失败，回退本机', { error: e.message }); }
    this._viaMcp = false;
    const shot = await gui.screenshot();
    return shot.ok ? shot.png_base64 : null;
  }

  // 执行动作：优先走 MCP，失败回退本机
  async _execute(act) {
    try {
      if (mcp.url) {
        switch (act.action) {
          case 'move': return await mcp.mouseMove(act.x, act.y);
          case 'click': return await mcp.mouseClick(act.x, act.y, act.button || 'left');
          case 'type': return await mcp.keyboardType(act.text || '');
          case 'hotkey': return await mcp.callTool('keyboard_hotkey', { combo: (act.keys && act.keys.join('+')) || (act.text || '') });
          case 'scroll': return await mcp.callTool('mouse_scroll', { amount: act.y || 3 }).catch(() => gui.mouse('scroll', { amount: act.y || 3 }));
          default: throw new Error('未知动作: ' + act.action);
        }
      }
    } catch (e) {
      logger.warn('MCP 动作失败，回退本机', { action: act.action, error: e.message });
    }
    // 回退：本机直连
    switch (act.action) {
      case 'move': return gui.mouse('move', { x: act.x, y: act.y });
      case 'click': return gui.mouse('click', { x: act.x, y: act.y, button: act.button || 'left', clicks: 1 });
      case 'type': return gui.keyboard('write', { text: act.text || '' });
      case 'hotkey': return gui.keyboard('hotkey', { combo: act.keys && act.keys.join('+') || (act.text || '') });
      case 'scroll': return gui.mouse('scroll', { amount: act.y || 3 });
      default: throw new Error('未知动作: ' + act.action);
    }
  }
}

module.exports = new GuiAgent();
