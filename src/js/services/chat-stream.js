// chat-stream.js - 流式聊天服务（SSE）
// 事件协议：
//   plan       → {phases:[...], current:0}         工作流规划
//   status     → {phase, message, progress}        阶段状态
//   tool_call  → {tool, status:'running'|'done', detail}  工具调用
//   token      → {delta}                           模型流式输出
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
  // 规划工作流阶段（依据当前配置动态生成）
  planWorkflow({ useRag, useSearch, hasRole, canDeliberate }) {
    const phases = ['规划'];
    if (useRag) phases.push('知识检索');
    if (useSearch) phases.push('联网搜索');
    if (hasRole) phases.push('角色装配');
    phases.push(canDeliberate ? '多模型合议' : '模型生成');
    phases.push('输出');
    return phases;
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
    emit('status', { phase: '规划', message: '已生成工作流计划', progress: 5 });

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

    // ---- 模型生成（单模型流式 / 合议并行） ----
    const phaseName = canDeliberate ? '多模型合议' : '模型生成';
    let finalText = '';
    let strategy = 'single';
    let contributors = [];
    let toolCalls = [];
    let reasoningText = '';
    let streamedByLoop = false; // agent-loop 是否已实时流式输出（避免重复回放）
    emit('status', { phase: phaseName, message: canDeliberate ? '并行调度 ' + scheduler.effectiveApiCount() + ' 个模型' : '单模型生成中…', progress: 55 });

    // ---- 自动截图注入（GUI 模式） ----
    // 用户消息含"屏幕/看/截屏/检测"等意图时，自动截屏并作为多模态图像直接给模型，
    // 不依赖模型主动调用工具（部分vision模型工具遵循差）。GUI 不强行：无vision模型或未开GUI则跳过。
    let autoScreenshotB64 = null;
    const guiCfg = config.get(['guiAgent']) || {};
    const guiOn = !!guiCfg.enabled && guiCfg.mode !== 'none';
    const screenIntent = /(屏幕|截屏|截图|看(看|一下)?(屏幕|桌面)|桌面|显示器|当前(屏幕|页面)|screen|screenshot|desktop)/i.test(message || '');
    logger.info('GUI截屏检测', { guiOn, screenIntent, canGui: permissions.can('guiControl'), msg: String(message).slice(0, 30) });
    if (guiOn && screenIntent && permissions.can('guiControl')) {
      try {
        const gui = require('../tools/gui-automation');
        const s = await gui.screenshot();
        if (s.ok && s.png_base64) {
          autoScreenshotB64 = s.png_base64;
          logger.info('自动截屏成功', { w: s.width, h: s.height, b64len: s.png_base64.length });
          emit('status', { phase: phaseName, message: '已自动截取屏幕（GUI 模式）', progress: 60 });
          emit('tool_call', { tool: 'gui_screenshot', status: 'running', detail: '自动截屏（GUI 模式）' });
          emit('tool_call', { tool: 'gui_screenshot', status: 'done', detail: '自动截屏完成' });
          toolCalls.push({ tool: 'gui_screenshot', args: {}, result: { ok: true, width: s.width, height: s.height, image: true } });
        }
      } catch (e) {
        logger.warn('自动截屏失败', { error: e.message });
      }
    }

    const runSingle = async (modelCfg, retry = 0) => {
      // 若已自动截屏：构造多模态消息（图像+文本），让 vision 模型直接看图
      let msgs;
      if (autoScreenshotB64 && retry === 0) {
        // 注意：vision 模型对长系统提示+图像会空输出，这里用精简系统提示
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
      // 流式
      let firstTokenSent = false;
      await provider.stream(modelCfg, msgs, {
        temperature: p.temperature, topP: p.topP, timeoutMs: modelCfg.timeoutMs,
        // 保证足够输出空间（部分vision模型小maxTokens会空返回）
        maxTokens: Math.max(modelCfg.maxTokens || 2048, 2048),
        onToken: (delta) => {
          finalText += delta;
          if (!firstTokenSent) { emit('token', { delta, first: true }); firstTokenSent = true; }
          else emit('token', { delta });
        }
      });
      scheduler.recordSuccess(modelCfg.id);
      logger.info('模型流式完成', { retry, hasImg: !!autoScreenshotB64, textLen: finalText.length });
      // 空输出兜底：重试一次（简化系统提示）
      if (!finalText && retry < 1) {
        logger.warn('模型空输出，重试（简化提示）', { model: modelCfg.id });
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
    // 原生 function calling 工具步骤：使用核心 agent-loop 模块（支持实时流式输出）
    const agentLoopStep = async (modelCfg) => {
      if (!toolRunner.isEnabled() || !toolRunner.toolSchemas().length) return false;

      const loadedSkills = skills.loadedContent ? skills.loadedContent() : '';
      const sysContent = '你是O-yuan助手，可以调用工具完成任务。需要执行命令时用 run_command；需要看屏幕时用 gui_screenshot；需要搜索时用 web_search；需要查知识库时用 kb_query；需要委派独立任务时用 subagent；需要分阶段编排时用 workflow；需要加载技能时用 load_skill。调用工具后，你会收到工具结果，请根据结果继续推理，直到任务完成。'
        + (loadedSkills ? '\n\n[已加载技能指令]\n' + loadedSkills : '')
        + (planMode.isActive() ? '\n\n' + planMode.guidance() : '');

      let firstToken = true;
      const loopResult = await agentLoop.run({
        modelCfg,
        systemPrompt: sysContent,
        userMessage: message,
        maxSteps: config.get(['agentLoop', 'maxSteps']) || 50,
        maxTokens: config.get(['agentLoop', 'maxTokens']) || 4096,
        stream: true,
        onToken: (delta) => {
          // 实时流式输出最终回答
          streamedByLoop = true;
          emit('token', { delta, first: firstToken });
          firstToken = false;
        },
        onToolStart: (toolName, args) => {
          const argStr = args && Object.keys(args).length ? JSON.stringify(args).slice(0, 80) : '';
          emit('tool_call', { tool: toolName, status: 'running', detail: argStr ? toolName + '(' + argStr + ')' : '调用 ' + toolName });
        },
        onToolEnd: (toolName, result) => {
          let detail = toolName + ' 完成';
          if (result && result.ok) {
            // 显示结果摘要（前100字符）
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
        }
      });

      if (loopResult.text) {
        finalText = loopResult.text;
      }
      toolCalls = loopResult.toolCalls || [];
      if (loopResult.reasoning && !reasoningText) reasoningText = loopResult.reasoning;
      return toolCalls.length > 0;
    };

    if (!canDeliberate) {
      // 支持用户指定模型（输入框模型选择器），否则用第一个可用模型
      let m = null;
      if (session && session.modelId) {
        m = scheduler.eligibleModels().find(x => x.id === session.modelId);
      }
      if (!m) m = scheduler.eligibleModels()[0];
      if (!m) throw new Error('没有可用模型');
      emit('tool_call', { tool: 'model:' + m.id, status: 'running', detail: '开始生成…' });
      try {
        // Agent 闭环：模型可多轮调用工具（run_command/gui/搜索等），结果回填继续推理；
        // 若模型全程无工具调用则直接流式生成
        const usedTools = await agentLoopStep(m);
        if (!usedTools && !finalText) await runSingle(m);
        emit('tool_call', { tool: 'model:' + m.id, status: 'done' });
      } catch (e) {
        emit('tool_call', { tool: 'model:' + m.id, status: 'done', error: e.message });
        emit('status', { phase: phaseName, message: '生成失败: ' + e.message, progress: 55 });
      }
    } else {
      // 合议模式：并行调用（暂不流式，输出阶段回放）
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

    // ---- 输出阶段（流式回放，仅当 agent-loop 未实时流式时） ----
    emit('status', { phase: '输出', message: '整理输出…', progress: 90 });
    if (!streamedByLoop && finalText) {
      // 分块回放实现打字机效果（非真实token，但保留流式体验）
      const chunks = chunkText(finalText, 6);
      for (const c of chunks) {
        emit('token', { delta: c });
        await sleep(8);
      }
    }
    emit('status', { phase: '输出', message: '完成', progress: 100 });

    // 记录历史与消费；携带工具调用轨迹（meta），并追加结构化会话事件（采用业界通用做法：事件日志）
    risk.record({ tokens: Math.max(500, Math.round(message.length / 2)), modelId: contributors[0] });
    if (toolCalls.length) sessionStore.recordEvent(sessionId, 'turn/tool_calls', { toolCalls });
    if (features.isEnabled('sessionMemory')) sessionStore.push(sessionId, message, finalText, { meta: toolCalls.length ? { toolCalls } : undefined });

    emit('done', { text: finalText, strategy, contributors, mode: canDeliberate ? 'deliberation' : 'single', sessionId, toolCalls, reasoning: reasoningText || undefined });
  }
}

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = new ChatStreamService();
