// workflow.js - 工作流编排（采用业界通用做法：workflow）
// 模型/用户通过 workflow 工具提交一个分阶段的任务计划：
//   { name, description, phases: [ { title, tasks: [ { prompt, label, parallel } ] } ] }
// 引擎逐阶段执行：同一阶段的多个任务可并行（复用 subagent + task-queue），
// 前一阶段所有任务完成后进入下一阶段，最终汇总各任务结果。
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const subagent = require('./subagent');
const taskQueue = require('./task-queue');

class WorkflowEngine {
  // 运行一个工作流计划，返回 { ok, result } 或 { ok:false, error }
  // plan: { name, description, phases: [{ title, tasks: [{ prompt, label, parallel }] }] }
  async run(plan, opts = {}) {
    if (!plan || typeof plan !== 'object') throw new Error('工作流计划必须是对象');
    if (!plan.phases || !Array.isArray(plan.phases) || !plan.phases.length) {
      throw new Error('工作流至少需要一个阶段(phases)');
    }
    const startedAt = Date.now();
    const phaseResults = [];
    const allTaskResults = [];
    let totalTasks = 0;
    plan.phases.forEach(p => { if (p.tasks) totalTasks += p.tasks.length; });
    logger.info('工作流启动', { name: plan.name || '(unnamed)', phases: plan.phases.length, tasks: totalTasks });

    for (let pi = 0; pi < plan.phases.length; pi++) {
      const phase = plan.phases[pi];
      const tasks = (phase.tasks || []).map((t, i) => ({
        prompt: String(t.prompt || '').trim(),
        label: t.label || ('task-' + (i + 1)),
        parallel: t.parallel !== false
      }));
      if (!tasks.length) { phaseResults.push({ title: phase.title, results: [] }); continue; }
      logger.info('工作流阶段', { phase: phase.title, tasks: tasks.length, parallel: tasks.every(t=>t.parallel) });

      // 阶段内任务执行：并行（Promise.all，复用 subagent）或串行
      let results;
      if (tasks.every(t => t.parallel)) {
        results = await Promise.all(tasks.map(async (t) => {
          try {
            const r = await subagent.run(t.prompt, { description: t.label });
            return { label: t.label, ok: r.ok, result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error };
          } catch (e) {
            return { label: t.label, ok: false, error: e.message };
          }
        }));
      } else {
        results = [];
        for (const t of tasks) {
          try {
            const r = await subagent.run(t.prompt, { description: t.label });
            results.push({ label: t.label, ok: r.ok, result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error });
          } catch (e) {
            results.push({ label: t.label, ok: false, error: e.message });
          }
        }
      }
      phaseResults.push({ title: phase.title, results });
      allTaskResults.push(...results);
    }

    const okCount = allTaskResults.filter(r => r.ok).length;
    const duration = Date.now() - startedAt;
    logger.info('工作流完成', { name: plan.name, ok: okCount + '/' + allTaskResults.length, ms: duration });
    return {
      ok: true,
      result: {
        name: plan.name || '(unnamed)',
        description: plan.description || '',
        phases: phaseResults,
        stats: { totalTasks, okTasks: okCount, failedTasks: allTaskResults.length - okCount, durationMs: duration }
      }
    };
  }
}

module.exports = new WorkflowEngine();
