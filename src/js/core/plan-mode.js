// plan-mode.js - 计划模式
// 开启计划模式后，agent 先规划执行步骤，把完整计划呈现给用户审查。
// 开发者导向：计划呈现后自动批准（无审批等待），仅记录计划内容。
'use strict';
const logger = require('./logger');

class PlanMode {
  constructor() {
    this.active = false;
    this.currentPlan = '';
  }

  enter() { this.active = true; this.currentPlan = ''; logger.info('计划模式开启'); }
  leave() { this.active = false; logger.info('计划模式退出'); }
  toggle() { this.active ? this.leave() : this.enter(); return this.active; }
  isActive() { return this.active; }

  // 呈现计划。开发者导向：直接批准，不等待用户审批。
  async presentPlan(plan) {
    const text = String(plan || '').trim();
    if (!text) return { approved: false, plan: '', error: '计划为空' };
    this.currentPlan = text;
    logger.info('呈现计划（自动批准）', { len: text.length });
    return { approved: true, plan: text };
  }

  // 计划模式的系统提示段
  guidance() {
    if (!this.active) return '';
    return '【计划模式】当前处于计划模式。请先规划执行步骤，不要直接执行。'
      + '完成计划后调用 exit_plan_mode 工具，把完整计划(以#标题开头)呈现给用户审查。'
      + '若用户批准则继续执行，若用户要求调整则修改计划后再次呈现。';
  }
}

module.exports = new PlanMode();
