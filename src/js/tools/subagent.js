// subagent.js - 子代理委派
// 主 agent 可通过 subagent 工具把独立任务委派给一个新的子代理。
// 子代理拥有独立上下文，可用基础工具（不含 subagent 避免无限递归），返回结果文本给主 agent。
// 支持两种模式：in-process（同进程，默认）和 isolated（独立进程隔离）。
// 支持并发/排队（复用 task-queue）、状态跟踪、取消。
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('../core/config');
const logger = require('../core/logger');
const scheduler = require('../deliberation/scheduler');
const toolRunner = require('./tool-runner');
const taskQueue = require('./task-queue');
const agentLoop = require('../core/agent-loop');

// 子代理可用工具：排除 subagent 自身（防无限递归）和 workflow（避免复杂嵌套）
function getSubagentTools() {
  try {
    return toolRunner.toolSchemas().filter(s =>
      s.function && s.function.name !== 'subagent' && s.function.name !== 'workflow'
    );
  } catch (e) { return []; }
}

// 活跃子代理注册表（用于状态查询和取消）
const activeSubagents = new Map();

class Subagent {
  constructor() {
    this.nextId = 1;
  }

  // 运行一个子代理任务，返回 { ok, result, subagentId } 或 { ok:false, error }
  // opts: { task, description, modelId, label, onProgress, mode: 'in-process'|'isolated', timeoutMs }
  run(task, opts = {}) {
    return new Promise((resolve) => {
      const id = 'sub-' + (this.nextId++) + '-' + Date.now().toString(36);
      const description = opts.description || '子代理任务';
      const mode = opts.mode || 'in-process';
      logger.info('子代理任务提交', { id, mode, description: description.slice(0, 60), taskLen: String(task).length });

      // 注册活跃子代理
      activeSubagents.set(id, { id, status: 'pending', description, mode, createdAt: Date.now(), cancelled: false });

      // 复用 task-queue 做并发调度
      const qid = taskQueue.submit(async () => {
        const entry = activeSubagents.get(id);
        if (entry) entry.status = 'running';
        if (mode === 'isolated') {
          return this._executeIsolated(task, opts, id);
        }
        return this._executeInProcess(task, opts, id);
      }, {
        label: 'subagent:' + description.slice(0, 30),
        timeout: (opts.timeoutMs || 300000)
      });

      // 监听队列完成事件
      const onTask = (payload) => {
        if (payload.id !== qid) return;
        const entry = activeSubagents.get(id);
        if (payload.status === 'completed') {
          taskQueue.removeListener('task', onTask);
          if (entry) { entry.status = 'completed'; entry.completedAt = Date.now(); }
          resolve({ ok: true, result: payload.result, subagentId: id, mode });
        } else if (payload.status === 'failed' || payload.status === 'timeout') {
          taskQueue.removeListener('task', onTask);
          if (entry) { entry.status = 'failed'; entry.error = payload.error || '超时'; }
          resolve({ ok: false, error: payload.error || '子代理任务超时', subagentId: id });
        }
      };
      taskQueue.on('task', onTask);
    });
  }

  // 同进程执行：使用核心 agent-loop 模块
  async _executeInProcess(task, opts, subagentId) {
    if (!task || !String(task).trim()) throw new Error('子代理任务不能为空');
    const modelId = opts.modelId;
    let modelCfg;
    const models = scheduler.eligibleModels();
    if (modelId) modelCfg = models.find(m => m.id === modelId);
    if (!modelCfg) modelCfg = models[0];
    if (!modelCfg) throw new Error('没有可用模型来运行子代理');

    const entry = activeSubagents.get(subagentId);
    const tools = getSubagentTools();
    const systemPrompt = '你是O-yuan的子代理，负责独立完成主代理委派的任务。你可以调用工具（如 run_command 执行命令、read_file/read_file 读取文件、web_search 搜索、shell_exec 持久化 shell 等）。调用工具后会收到结果，请根据结果继续，直到完成任务，最后用自然语言输出最终结果。不要调用 subagent 工具。';

    const result = await agentLoop.run({
      modelCfg,
      systemPrompt,
      userMessage: String(task),
      tools,
      maxSteps: config.get(['subagent', 'maxSteps']) || 30,
      maxTokens: config.get(['subagent', 'maxTokens']) || 4096,
      signal: { aborted: entry ? entry.cancelled : false }
    });

    if (!result.text || !result.text.trim()) {
      throw new Error('子代理未产出有效结果');
    }
    return result.text;
  }

  // 独立进程执行：spawn 一个新的 Node.js 进程运行子代理
  async _executeIsolated(task, opts, subagentId) {
    if (!task || !String(task).trim()) throw new Error('子代理任务不能为空');

    // 创建临时脚本文件
    const script = this._buildSubagentScript(task, opts);
    const scriptFile = path.join(os.tmpdir(), 'oyuan_subagent_' + subagentId.replace(/[^a-zA-Z0-9]/g, '_') + '.mjs');
    fs.writeFileSync(scriptFile, script, 'utf8');

    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [scriptFile], {
        cwd: process.cwd(),
        env: { ...process.env, OYUAN_SUBAGENT_ID: subagentId },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '', stderr = '';
      let resultData = null;
      const timeout = opts.timeoutMs || 300000;
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
        cleanup();
        reject(new Error('子代理进程超时(' + (timeout / 1000) + 's)'));
      }, timeout);

      function cleanup() {
        clearTimeout(timer);
        try { fs.unlinkSync(scriptFile); } catch (e) { /* ignore */ }
      }

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        // 尝试解析 JSON 结果（最后一行）
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && parsed.__subagent_result__) {
              resultData = parsed;
              break;
            }
          } catch (e) { /* not JSON */ }
        }
      });
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('error', (err) => {
        cleanup();
        reject(new Error('无法启动子代理进程: ' + err.message));
      });

      proc.on('close', (code) => {
        cleanup();
        if (resultData && resultData.ok) {
          resolve(resultData.result);
        } else if (resultData && !resultData.ok) {
          reject(new Error(resultData.error || '子代理执行失败'));
        } else if (code === 0 && stdout.trim()) {
          // 没有 JSON 结果但有输出，取最后非空行
          const lines = stdout.trim().split('\n').filter(l => l.trim());
          resolve(lines[lines.length - 1] || stdout.trim());
        } else {
          reject(new Error('子代理进程退出码 ' + code + (stderr ? ': ' + stderr.slice(0, 500) : '')));
        }
      });
    });
  }

  // 构建独立进程的子代理脚本
  _buildSubagentScript(task, opts) {
    // 简化版：直接调用主进程的 agent-loop（通过 require 绝对路径）
    const projectRoot = path.resolve(__dirname, '../../..');
    return `
import { pathToFileURL } from 'url';
const agentLoop = await import(pathToFileURL(${JSON.stringify(path.join(projectRoot, 'src/js/core/agent-loop.js'))}).href);
const scheduler = await import(pathToFileURL(${JSON.stringify(path.join(projectRoot, 'src/js/deliberation/scheduler.js'))}).href);
const toolRunner = await import(pathToFileURL(${JSON.stringify(path.join(projectRoot, 'src/js/tools/tool-runner.js'))}).href);
const config = await import(pathToFileURL(${JSON.stringify(path.join(projectRoot, 'src/js/core/config.js'))}).href);

config.default.load();
scheduler.default.init();

const models = scheduler.default.eligibleModels();
const model = models[0];
if (!model) {
  console.log(JSON.stringify({ __subagent_result__: true, ok: false, error: '没有可用模型' }));
  process.exit(1);
}

const tools = toolRunner.default.toolSchemas().filter(s =>
  s.function && s.function.name !== 'subagent' && s.function.name !== 'workflow'
);

const result = await agentLoop.default.run({
  modelCfg: model,
  systemPrompt: '你是O-yuan的子代理，负责独立完成主代理委派的任务。可以调用工具，完成后用自然语言输出最终结果。',
  userMessage: ${JSON.stringify(String(task))},
  tools,
  maxSteps: 30,
  maxTokens: 4096
});

console.log(JSON.stringify({ __subagent_result__: true, ok: true, result: result.text || '' }));
process.exit(0);
`;
  }

  // 查询子代理状态
  status(subagentId) {
    if (subagentId) {
      const entry = activeSubagents.get(subagentId);
      return entry ? { ok: true, ...entry } : { ok: false, error: '子代理不存在: ' + subagentId };
    }
    return {
      ok: true,
      active: Array.from(activeSubagents.values()).filter(s => s.status === 'running' || s.status === 'pending'),
      total: activeSubagents.size
    };
  }

  // 取消子代理
  cancel(subagentId) {
    const entry = activeSubagents.get(subagentId);
    if (!entry) return { ok: false, error: '子代理不存在: ' + subagentId };
    entry.cancelled = true;
    entry.status = 'cancelled';
    logger.info('子代理已取消', { subagentId });
    return { ok: true, subagentId };
  }

  // 清理已完成的子代理记录
  cleanup(olderThanMs = 3600000) {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of activeSubagents.entries()) {
      if ((entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') &&
          entry.completedAt && (now - entry.completedAt > olderThanMs)) {
        activeSubagents.delete(id);
        removed++;
      }
    }
    return { ok: true, removed };
  }
}

module.exports = new Subagent();
