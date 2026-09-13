// chat-stream.js - 流式聊天服务（SSE）
// 事件协议：
//   plan       → {phases:[...], current:0}         工作流规划
//   todo       → {steps:[{id,text,status}], current}  计划表
//   status     → {phase, message, progress}        阶段状态
//   tool_call  → {tool, status:'running'|'done', detail}  工具调用
//   token      → {delta}                           模型流式输出
//   think      → {text}                            模型思考
//   done       → {text, mode, strategy, ...}       完成
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const roles = require('../core/roles');
const kb = require('../core/kb');
const scheduler = require('../deliberation/scheduler');
const provider = require('../deliberation/provider');
const features = require('../core/features');
const sessionStore = require('../core/session');
const toolRunner = require('../tools/tool-runner');
const risk = require('../tools/risk');
const permissions = require('../core/permissions');
const agentLoop = require('../core/agent-loop');
const planMode = require('../core/plan-mode');
const skills = require('../core/skills');

class ChatStreamService {
  planWorkflow({ useRag, useSearch, hasRole, canDeliberate }) {
    const phases = ['规划'];
    if (useRag) phases.push('知识检索');
    if (useSearch) phases.push('联网搜索');
    if (hasRole) phases.push('角色装配');
    phases.push(canDeliberate ? '多模型合议' : '模型生成');
    phases.push('输出');
    return phases;
  }

  // 让模型自动规划任务步骤（快速调用，只输出 JSON 步骤列表）
  async autoPlanSteps(modelCfg, userMessage) {
    try {
      const planPrompt = '你是一个任务规划器。请分析用户任务，将其分解为 3-6 个清晰的执行步骤。' +
        '只返回 JSON 数组，每个元素是一个步骤描述字符串，不要有其他文字。' +
        '例如：["分析需求","搜索资料","整理结果"]\n\n用户任务：' + userMessage;
      const res = await provider.call(modelCfg, [
        { role: 'user', content: planPrompt }
      ], { temperature: 0.3, maxTokens: 500, timeoutMs: 30000 });
      let text = (res.content || '').trim();
      // 提取 JSON 数组
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const steps = JSON.parse(match[0]);
        if (Array.isArray(steps) && steps.length > 0) {
          return steps.slice(0, 8).map((s, i) => ({ id: i, text: String(s).slice(0, 100), status: 'pending' }));
        }
      }
    } catch (e) {
      logger.warn('自动规划失败', { error: e.message });
    }
    return null;
  }

  async handleStream(message, session, emit) {
    const sessionId = (session && session.sessionId) || 'default';
    const thinkLevel = config.get(['think', 'level']) != null ? config.get(['think', 'level']) : 5;
    const useRag = config.get(['rag', 'enabled']) && kb.enabled;
    const useSearch = config.get(['search', 'enabled']);
    const hasRole = roles.enabled && !!roles.selectedRole;
    const canDeliberate = scheduler.canDeliberate();
    const phases = this.planWorkflow({ useRag, useSearch, hasRole, canDeliberate });

    emit('plan', { phases, current: 0 });
    emit('status', { phase: '规划', message: '正在分析任务…', progress: 5 });

    // ---- SSE 心跳：长时间工具执行时保持连接 ----
    let heartbeatTimer = setInterval(() => {
      emit('heartbeat', { t: Date.now() });
    }, 15000);

    // ---- 自动任务规划 ----
    let todoSteps = null;
    const primaryModel = scheduler.eligibleModels()[0];
    if (primaryModel && toolRunner.isEnabled()) {
      emit('status', { phase: '规划', message: '正在生成执行计划…', progress: 8 });
      todoSteps = await this.autoPlanSteps(primaryModel, message);
      if (todoSteps) {
        emit('todo', { steps: todoSteps, current: 0 });
        emit('status', { phase: '规划', message: '已生成 ' + todoSteps.length + ' 步计划', progress: 12 });
      }
    }

    // ---- 知识检索 ----
    let kbSnippets = [];
    if (useRag) {
      emit('status', { phase: '知识检索', message: '正在检索本地知识库…', progress: 15 });
      try {
        kbSnippets = await kb.search(message, config.get(['rag','maxRefs']));
        emit('status', { phase: '知识检索', message: '检索到 ' + kbSnippets.length + ' 个相关片段', progress: 25 });
      } catch (e) {
        emit('status', { phase: '知识检索', message: '检索失败: ' + e.message, progress: 25 });
      }
    }

    // ---- 联网搜索 ----
    let searchResults = [];
    if (useSearch) {
      emit('status', { phase: '联网搜索', message: '正在联网搜索…', progress: 35 });
      try {
        const st = require('../tools/search');
        searchResults = await st.search(message);
        emit('status', { phase: '联网搜索', message: '获得 ' + searchResults.length + ' 条结果', progress: 40 });
      } catch (e) {
        emit('status', { phase: '联网搜索', message: '搜索失败: ' + e.message, progress: 40 });
      }
    }

    // ---- 角色装配 ----
    let rolePrompt = '';
    if (hasRole) {
      rolePrompt = roles.renderSystemPrompt(roles.selectedRole);
      emit('status', { phase: '角色装配', message: '已装配角色「' + roles.selectedRole.name + '」', progress: 45 });
    }

    // ---- 历史上下文 ----
    const historyPrompt = features.isEnabled('sessionMemory') ? sessionStore.buildHistoryPrompt(sessionId) : '';
    const roleId = hasRole ? roles.selectedRole.id : '';
    const toolNote = toolRunner.isEnabled() ? toolRunner.toolDescription() : '';
    const basePrompt = (historyPrompt ? historyPrompt + '\n\n' : '') + rolePrompt + (toolNote ? '\n\n' + toolNote : '');

    const phaseName = canDeliberate ? '多模型合议' : '模型生成';
    let finalText = '';
    let strategy = 'single';
    let contributors = [];
    let toolCalls = [];
    let reasoningText = '';
    let streamedByLoop = false;
    emit('status', { phase: phaseName, message: canDeliberate ? '并行调度 ' + scheduler.effectiveApiCount() + ' 个模型' : '单模型生成中…', progress: 55 });

    // ---- 自动截图注入 ----
    let autoScreenshotB64 = null;
    const guiCfg = config.get(['guiAgent']) || {};
    const guiOn = !!guiCfg.enabled && guiCfg.mode !== 'none';
    const screenIntent = /(屏幕|截屏|截图|看(看|一下)?(屏幕|桌面)|桌面|显示器|当前(屏幕|页面)|screen|screenshot|desktop)/i.test(message || '');
    if (guiOn && screenIntent && permissions.can('guiControl')) {
      try {
        const gui = require('../tools/gui-automation');
        const s = await gui.screenshot();
        if (s.ok && s.png_base64) {
          autoScreenshotB64 = s.png_base64;
          emit('status', { phase: phaseName, message: '已自动截取屏幕', progress: 60 });
          emit('tool_call', { tool: 'gui_screenshot', status: 'running', detail: '自动截屏' });
          emit('tool_call', { tool: 'gui_screenshot', status: 'done', detail: '截屏完成' });
          toolCalls.push({ tool: 'gui_screenshot', args: {}, result: { ok: true, width: s.width, height: s.height, image: true } });
        }
      } catch (e) {
        logger.warn('自动截屏失败', { error: e.message });
      }
    }

    const runSingle = async (modelCfg, retry = 0) => {
      let msgs;
      if (autoScreenshotB64 && retry === 0) {
        msgs = [
          { role: 'system', content: '你是O-yuan助手，可以查看图像。请基于屏幕截图内容直接回答用户，不要输出任何JSON或工具调用。' },
          { role: 'user', content: [
            { type: 'text', text: message },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + autoScreenshotB64 } }
          ] }
        ];
      } else {
        msgs = scheduler.buildMessages(basePrompt, message, modelCfg, rolePrompt, kbSnippets, searchResults, thinkLevel);
      }
      const p = scheduler.thinkParams(modelCfg, thinkLevel);
      let firstTokenSent = false;
      await provider.stream(modelCfg, msgs, {
        temperature: p.temperature, topP: p.topP, timeoutMs: modelCfg.timeoutMs,
        maxTokens: Math.max(modelCfg.maxTokens || 2048, 2048),
        onToken: (delta) => {
          finalText += delta;
          if (!firstTokenSent) { emit('token', { delta, first: true }); firstTokenSent = true; }
          else emit('token', { delta });
        }
      });
      scheduler.recordSuccess(modelCfg.id);
      if (!finalText && retry < 1) {
        logger.warn('模型空输出，重试', { model: modelCfg.id });
        const simpleMsgs = [{ role: 'system', content: '你是O-yuan助手，请直接自然语言回答用户。' }, { role: 'user', content: message }];
        const sp = scheduler.thinkParams(modelCfg, thinkLevel);
        finalText = '';
        firstTokenSent = false;
        await provider.stream(modelCfg, simpleMsgs, {
          temperature: sp.temperature, topP: sp.topP, timeoutMs: modelCfg.timeoutMs,
          maxTokens: 2048,
          onToken: (delta) => {
            finalText += delta;
            if (!firstTokenSent) { emit('token', { delta, first: true }); firstTokenSent = true; }
            else emit('token', { delta });
          }
        });
      }
      strategy = 'single';
      contributors = [modelCfg.id];
    };

    // Agent 闭环：模型可多轮调用工具
    const agentLoopStep = async (modelCfg) => {
      if (!toolRunner.isEnabled() || !toolRunner.toolSchemas().length) return false;

      const loadedSkills = skills.loadedContent ? skills.loadedContent() : '';
      const sysContent = '你是O-yuan助手，可以调用工具完成任务。需要执行命令时用 run_command；需要看屏幕时用 gui_screenshot；需要搜索时用 web_search；需要查知识库时用 kb_query；需要委派独立任务时用 subagent；需要分阶段编排时用 workflow；需要加载技能时用 load_skill。'
        + '调用工具后你会收到结果，请根据结果继续推理，直到任务完成并给出最终回答。'
        + (loadedSkills ? '\n\n[已加载技能指令]\n' + loadedSkills : '')
        + (planMode.isActive() ? '\n\n' + planMode.guidance() : '');

      let firstToken = true;
      let stepIdx = 0;
      const loopResult = await agentLoop.run({
        modelCfg,
        systemPrompt: sysContent,
        userMessage: message,
        maxSteps: config.get(['agentLoop', 'maxSteps']) || 50,
        maxTokens: config.get(['agentLoop', 'maxTokens']) || 4096,
        stream: true,
        onToken: (delta) => {
          streamedByLoop = true;
          emit('token', { delta, first: firstToken });
          firstToken = false;
        },
        onToolStart: (toolName, args) => {
          const argStr = args && Object.keys(args).length ? JSON.stringify(args).slice(0, 80) : '';
          emit('tool_call', { tool: toolName, status: 'running', detail: argStr ? toolName + '(' + argStr + ')' : '调用 ' + toolName });
          // 更新计划表状态
          if (todoSteps && stepIdx < todoSteps.length) {
            todoSteps[stepIdx].status = 'active';
            emit('todo', { steps: todoSteps, current: stepIdx });
            stepIdx++;
          }
        },
        onToolEnd: (toolName, result) => {
          let detail = toolName + ' 完成';
          if (result && result.ok) {
            const resStr = result.result != null ? JSON.stringify(result.result).slice(0, 100) : '';
            if (resStr) detail = toolName + ' → ' + resStr;
          } else if (result && result.error) {
            detail = toolName + ' 失败: ' + String(result.error).slice(0, 80);
          }
          emit('tool_call', { tool: toolName, status: 'done', detail, error: result && !result.ok ? result.error : undefined });
        },
        onThink: (text) => {
          if (!reasoningText) {
            reasoningText = text;
            emit('think', { text });
          }
        },
        onHeartbeat: (phase) => {
          emit('heartbeat', { phase, t: Date.now() });
        }
      });

      // 检查错误
      if (loopResult.error && !loopResult.text) {
        finalText = '抱歉，处理过程中出现错误: ' + loopResult.error;
      } else if (loopResult.text) {
        finalText = loopResult.text;
      }
      toolCalls = loopResult.toolCalls || [];
      if (loopResult.reasoning && !reasoningText) reasoningText = loopResult.reasoning;

      // 标记剩余步骤完成
      if (todoSteps) {
        todoSteps.forEach((s, i) => {
          if (s.status === 'pending' || s.status === 'active') s.status = 'done';
        });
        emit('todo', { steps: todoSteps, current: todoSteps.length });
      }

      return toolCalls.length > 0 || !!loopResult.text;
    };

    try {
      if (!canDeliberate) {
        let m = null;
        if (session && session.modelId) {
          m = scheduler.eligibleModels().find(x => x.id === session.modelId);
        }
        if (!m) m = scheduler.eligibleModels()[0];
        if (!m) throw new Error('没有可用模型');
        emit('tool_call', { tool: 'model:' + m.id, status: 'running', detail: '开始生成…' });
        const usedTools = await agentLoopStep(m);
        if (!usedTools && !finalText) await runSingle(m);
        emit('tool_call', { tool: 'model:' + m.id, status: 'done' });
      } else {
        emit('status', { phase: phaseName, message: '合议调度中…', progress: 65 });
        const eligible = scheduler.eligibleModels();
        const results = await Promise.all(eligible.map(async (m) => {
          try {
            const msgs = scheduler.buildMessages(basePrompt, message, m, rolePrompt, kbSnippets, searchResults, thinkLevel);
            const p = scheduler.thinkParams(m, thinkLevel);
            const res = await provider.call(m, msgs, { temperature: p.temperature, topP: p.topP, timeoutMs: m.timeoutMs, maxTokens: m.maxTokens });
            scheduler.recordSuccess(m.id);
            return { modelId: m.id, weight: m.weight || 1, content: res.content, ok: true };
          } catch (e) {
            scheduler.recordFailure(m.id);
            return { modelId: m.id, weight: m.weight || 1, error: e.message, ok: false };
          }
        }));
        const ok = results.filter(r => r.ok);
        if (!ok.length) throw new Error('所有模型调用失败');
        const agg = await scheduler._aggregate(ok, { basePrompt, userMsg: message, rolePrompt, kbSnippets, searchResults, thinkLevel });
        finalText = agg.text;
        strategy = agg.strategy;
        contributors = agg.contributors || [];
        emit('status', { phase: phaseName, message: '合议完成（' + strategy + '）', progress: 80 });
      }
    } catch (e) {
      logger.error('聊天处理异常', { error: e.message });
      finalText = finalText || '处理失败: ' + e.message;
      emit('status', { phase: phaseName, message: '出错了: ' + e.message, progress: 55 });
    }

    // ---- 输出阶段 ----
    emit('status', { phase: '输出', message: '整理输出…', progress: 90 });
    if (!streamedByLoop && finalText) {
      const chunks = chunkText(finalText, 6);
      for (const c of chunks) {
        emit('token', { delta: c });
        await sleep(8);
      }
    }
    emit('status', { phase: '输出', message: '完成', progress: 100 });

    // 清理心跳
    clearInterval(heartbeatTimer);

    // 记录历史
    risk.record({ tokens: Math.max(500, Math.round(message.length / 2)), modelId: contributors[0] });
    if (toolCalls.length) sessionStore.recordEvent(sessionId, 'turn/tool_calls', { toolCalls });
    if (features.isEnabled('sessionMemory')) sessionStore.push(sessionId, message, finalText, { meta: toolCalls.length ? { toolCalls } : undefined });

    emit('done', { text: finalText, strategy, contributors, mode: canDeliberate ? 'deliberation' : 'single', sessionId, toolCalls, reasoning: reasoningText || undefined, todoSteps: todoSteps || undefined });
  }
}

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = new ChatStreamService();
