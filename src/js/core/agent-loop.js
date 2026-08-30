// agent-loop.js - 核心 Agent Loop（原生 function calling）
// 统一的工具调用循环：模型请求工具 → 执行 → 回填 → 继续推理，直到模型输出最终文本。
// 特性：任意深度循环（可配置上限）、并行工具调用、无结果截断、工具钩子、图像工具多模态回填。
'use strict';
const logger = require('./logger');
const config = require('./config');
const provider = require('../deliberation/provider');
const toolRunner = require('../tools/tool-runner');
const hooks = require('./hooks');

const DEFAULT_MAX_STEPS = 50; // 单 turn 内最大工具循环步数（防死循环，可配置）
const DEFAULT_MAX_TOKENS = 4096;

class AgentLoop {
  // 执行一次完整的 Agent Loop。
  // opts: {
  //   modelCfg,            // 模型配置
  //   systemPrompt,        // 系统提示
  //   userMessage,         // 用户消息（字符串或多模态数组）
  //   history,             // 历史消息数组（可选）
  //   tools,               // 工具定义数组（不传则用 toolRunner.toolSchemas()）
  //   maxSteps,            // 最大循环步数（默认 50）
  //   maxTokens,           // 每次模型调用 max_tokens（默认 4096）
  //   temperature, topP,
  //   stream,              // 是否流式输出最终回答（默认 false）
  //   onToken,             // (delta) => void 流式回调
  //   onToolStart,         // (toolName, args) => void
  //   onToolEnd,           // (toolName, result) => void
  //   onThink,             // (reasoningText) => void
  //   signal,              // AbortSignal（可选）
  // }
  // 返回: { text, toolCalls, reasoning, steps, finished }
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
      signal = null
    } = opts;

    const toolDefs = tools || (toolRunner.isEnabled() ? toolRunner.toolSchemas() : []);
    const hasTools = toolDefs && toolDefs.length > 0;

    // 构建消息列表
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

    while (steps < maxSteps) {
      if (signal && signal.aborted) {
        return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: false, aborted: true };
      }

      steps++;
      let res;
      try {
        const callOpts = {
          temperature: temperature != null ? temperature : (modelCfg.temperature || 0.7),
          topP: topP != null ? topP : (modelCfg.topP || 1.0),
          timeoutMs: (modelCfg.timeoutMs || 120000) + 30000,
          maxTokens
        };
        if (hasTools) callOpts.tools = toolDefs;
        res = await provider.call(modelCfg, messages, callOpts);
      } catch (e) {
        logger.warn('AgentLoop 模型调用失败', { error: e.message, step: steps });
        // 最后一步失败：返回已有内容或错误
        if (!finalText) finalText = '模型调用失败: ' + e.message;
        return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: false, error: e.message };
      }

      // 捕获模型思考（DeepSeek reasoning_content）
      if (res.reasoning && !reasoningText) {
        reasoningText = String(res.reasoning);
        onThink(reasoningText);
      }

      const calls = res.toolCalls || [];

      // 本轮无工具调用：有内容则作为最终输出
      if (calls.length === 0) {
        if (res.content) finalText = res.content;
        // 流式输出：把最终内容按小块通过 onToken 发送（模拟流式效果）
        if (stream && finalText) {
          const chunkSize = 3;
          for (let i = 0; i < finalText.length; i += chunkSize) {
            if (signal && signal.aborted) break;
            onToken(finalText.slice(i, i + chunkSize));
            // 小延迟模拟真实流式（不阻塞事件循环太久）
            if (i % 30 === 0) await new Promise(r => setTimeout(r, 1));
          }
        }
        return { text: finalText, toolCalls, reasoning: reasoningText, steps, finished: true };
      }

      // 记录本轮 assistant 的 tool_calls（供对话连续性）
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: calls.map((c, ci) => ({
          id: c.id || ('call_' + steps + '_' + ci),
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) }
        }))
      });

      // 并行执行工具（同一轮的多个 tool_call 并行）
      const callIds = calls.map((c, ci) => c.id || ('call_' + steps + '_' + ci));
      const results = await Promise.all(calls.map(async (tc, ci) => {
        const callId = callIds[ci];
        const toolName = tc.name;
        const toolArgs = tc.arguments || {};

        onToolStart(toolName, toolArgs);

        // 钩子：工具调用前（可拦截）
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

        // 钩子：工具调用后
        await hooks.trigger('tool:after', { tool: toolName, args: toolArgs, result: toolRes });

        toolCalls.push({ tool: toolName, args: toolArgs, result: toolRes, callId });
        onToolEnd(toolName, toolRes);
        return { callId, result: toolRes, toolName, toolArgs };
      }));

      // 回填工具结果（每个 tool_call 必须有对应的 role:tool 消息，带 tool_call_id）
      for (const { callId, result, toolName } of results) {
        // 图像工具：tool 消息使用多模态 content（文本+图像），既满足 tool_call_id 要求又让模型看到图像
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
          // 通用解包工具结果：executeTool 返回 {ok, result}，command 工具的结果又在 result.result 内
          const inner = (result.result && result.result.result != null) ? result.result.result : result.result;
          let toolText;
          if (result.ok && inner && inner.stdout != null) {
            toolText = '命令退出码 ' + inner.exitCode + '，stdout:\n' + inner.stdout + (inner.stderr ? '\nstderr:\n' + inner.stderr : '');
          } else if (result.ok) {
            // 无截断：完整返回工具结果
            toolText = JSON.stringify(result.result);
          } else {
            toolText = result.error || '工具调用失败';
          }
          messages.push({ role: 'tool', tool_call_id: callId, content: toolText });
        }
      }

      logger.info('AgentLoop 步骤完成', { step: steps, tools: calls.map(c => c.name).join(',') });
    }

    // 达到最大步数：返回最后一次的内容
    if (!finalText && messages.length) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
      if (lastAssistant) finalText = lastAssistant.content;
    }
    logger.warn('AgentLoop 达到最大步数', { maxSteps, toolCalls: toolCalls.length });
    return { text: finalText || '（已达到最大工具调用步数 ' + maxSteps + '，任务未完成）', toolCalls, reasoning: reasoningText, steps, finished: false, maxStepsReached: true };
  }
}

module.exports = new AgentLoop();
