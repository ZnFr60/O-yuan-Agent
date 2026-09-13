// agent-loop.js - 核心 Agent Loop（原生 function calling）
// 统一的工具调用循环：模型请求工具 → 执行 → 回填 → 继续推理，直到模型输出最终文本。
// 特性：任意深度循环（可配置上限）、并行工具调用、智能结果截断、工具钩子、图像工具多模态回填、错误恢复。
'use strict';
const logger = require('./logger');
const config = require('./config');
const provider = require('../deliberation/provider');
const toolRunner = require('../tools/tool-runner');
const hooks = require('./hooks');

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOL_RESULT_CHARS = 4000; // 单个工具结果回填模型的最大字符数（防上下文爆炸）
const MAX_RETRY_ON_ERROR = 1; // 模型调用失败时重试次数

class AgentLoop {
  // 截断工具结果，防止上下文爆炸
  _truncate(text, maxLen = MAX_TOOL_RESULT_CHARS) {
    if (!text) return text;
    const s = String(text);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '\n...[结果过长，已截断，共 ' + s.length + ' 字符]';
  }

  // 执行一次完整的 Agent Loop。
  async run(opts) {
    const {
      modelCfg,
      systemPrompt = '',
      userMessage,
      history = [],
      tools = null,
      maxSteps = config.get(['agentLoop', 'maxSteps']) || DEFAULT_MAX_STEPS,
      maxTokens = config.get(['agentLoop', 'maxTokens']) || DEFAULT_MAX_TOKENS,
      temperature,
      topP,
      stream = false,
      onToken = () => {},
      onToolStart = () => {},
      onToolEnd = () => {},
      onThink = () => {},
      onHeartbeat = () => {},
      signal = null
    } = opts;

    const toolDefs = tools || (toolRunner.isEnabled() ? toolRunner.toolSchemas() : []);
    const hasTools = toolDefs && toolDefs.length > 0;

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (history && Array.isArray(history)) messages.push(...history);
    if (userMessage != null) {
      if (Array.isArray(userMessage)) {
        messages.push({ role: 'user', content: userMessage });
      } else {
        messages.push({ role: 'user', content: String(userMessage) });
      }
    }

    const toolCalls = [];
    let reasoningText = '';
    let steps = 0;
    let finalText = '';
    let lastError = null;

    while (steps < maxSteps) {
      if (signal && signal.aborted) {
        return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: false, aborted: true };
      }

      steps++;
      let res;
      let retryCount = 0;
      while (true) {
        try {
          const callOpts = {
            temperature: temperature != null ? temperature : (modelCfg.temperature || 0.7),
            topP: topP != null ? topP : (modelCfg.topP || 1.0),
            timeoutMs: (modelCfg.timeoutMs || 120000) + 30000,
            maxTokens
          };
          if (hasTools) callOpts.tools = toolDefs;
          onHeartbeat('model_call');
          res = await provider.call(modelCfg, messages, callOpts);
          break;
        } catch (e) {
          lastError = e;
          logger.warn('AgentLoop 模型调用失败', { error: e.message, step: steps, retry: retryCount });
          if (retryCount < MAX_RETRY_ON_ERROR) {
            retryCount++;
            onHeartbeat('retry:' + retryCount);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          if (!finalText) finalText = '模型调用失败: ' + e.message;
          return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: false, error: e.message };
        }
      }

      // 捕获模型思考
      if (res.reasoning && !reasoningText) {
        reasoningText = String(res.reasoning);
        onThink(reasoningText);
      }

      const calls = res.toolCalls || [];

      // 本轮无工具调用：有内容则作为最终输出
      if (calls.length === 0) {
        if (res.content) finalText = res.content;
        if (stream && finalText) {
          const chunkSize = 3;
          for (let i = 0; i < finalText.length; i += chunkSize) {
            if (signal && signal.aborted) break;
            onToken(finalText.slice(i, i + chunkSize));
            if (i % 30 === 0) await new Promise(r => setTimeout(r, 1));
          }
        }
        return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: true };
      }

      // 记录本轮 assistant 的 tool_calls
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: calls.map((c, ci) => ({
          id: c.id || ('call_' + steps + '_' + ci),
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) }
        }))
      });

      // 并行执行工具
      const callIds = calls.map((c, ci) => c.id || ('call_' + steps + '_' + ci));
      const results = await Promise.all(calls.map(async (tc, ci) => {
        const callId = callIds[ci];
        const toolName = tc.name;
        const toolArgs = tc.arguments || {};

        onToolStart(toolName, toolArgs);
        onHeartbeat('tool_start:' + toolName);

        const before = await hooks.trigger('tool:before', { tool: toolName, args: toolArgs });
        if (before.blocked) {
          const blockedRes = { ok: false, error: '工具被钩子拦截: ' + (before.reason || '') };
          toolCalls.push({ tool: toolName, args: toolArgs, result: blockedRes, callId });
          onToolEnd(toolName, blockedRes);
          return { callId, result: blockedRes, toolName, toolArgs };
        }

        let toolRes;
        try {
          toolRes = await toolRunner.executeTool(toolName, toolArgs);
        } catch (e) {
          toolRes = { ok: false, error: '工具执行异常: ' + e.message };
        }

        await hooks.trigger('tool:after', { tool: toolName, args: toolArgs, result: toolRes });

        toolCalls.push({ tool: toolName, args: toolArgs, result: toolRes, callId });
        onToolEnd(toolName, toolRes);
        return { callId, result: toolRes, toolName, toolArgs };
      }));

      // 回填工具结果（智能截断）
      for (const { callId, result, toolName } of results) {
        if (result.ok && result.result && result.result.png_base64) {
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: [
              { type: 'text', text: '[工具 ' + toolName + ' 返回了屏幕截图，尺寸 ' + (result.result.width || '?') + 'x' + (result.result.height || '?') + '，请查看图像内容]' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + result.result.png_base64 } }
            ]
          });
        } else {
          const inner = (result.result && result.result.result != null) ? result.result.result : result.result;
          let toolText;
          if (result.ok && inner && inner.stdout != null) {
            toolText = '命令退出码 ' + inner.exitCode + '，stdout:\n' + this._truncate(inner.stdout) + (inner.stderr ? '\nstderr:\n' + this._truncate(inner.stderr) : '');
          } else if (result.ok) {
            toolText = this._truncate(JSON.stringify(result.result));
          } else {
            toolText = this._truncate(result.error || '工具调用失败');
          }
          messages.push({ role: 'tool', tool_call_id: callId, content: toolText });
        }
      }

      logger.info('AgentLoop 步骤完成', { step: steps, tools: calls.map(c => c.name).join(',') });
    }

    if (!finalText && messages.length) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
      if (lastAssistant) finalText = lastAssistant.content;
    }
    logger.warn('AgentLoop 达到最大步数', { maxSteps, toolCalls: toolCalls.length });
    return { text: finalText || '（已达到最大工具调用步数 ' + maxSteps + '，任务未完成）', toolCalls, reasoning: reasoningText, steps, finished: false, maxStepsReached: true, error: lastError ? lastError.message : undefined };
  }
}

module.exports = new AgentLoop();
