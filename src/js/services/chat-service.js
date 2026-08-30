// chat-service.js - 聊天编排（串起 RAG / 搜索 / 角色 / 合议 / 缓存 / Agent Loop）
// 使用核心 agent-loop 模块进行原生 function calling 工具调用循环。
'use strict';
const config = require('../core/config');
const logger = require('../core/logger');
const roles = require('../core/roles');
const kb = require('../core/kb');
const searchTool = require('../tools/search');
const risk = require('../tools/risk');
const scheduler = require('../deliberation/scheduler');
const plugins = require('../tools/plugins');
const permissions = require('../core/permissions');
const sessionStore = require('../core/session');
const features = require('../core/features');
const toolRunner = require('../tools/tool-runner');
const provider = require('../deliberation/provider');
const agentLoop = require('../core/agent-loop');
const planMode = require('../core/plan-mode');
const skills = require('../core/skills');

class ChatService {
  async handleMessage(message, session) {
    // 插件前置拦截
    const intercepted = await plugins.runHook('onBeforeChat', message);
    if (intercepted === null) return { text: '[已被插件拦截]', interrupted: true };

    const thinkLevel = config.get(['think', 'level']) != null ? config.get(['think', 'level']) : 5;
    const useRag = config.get(['rag', 'enabled']);
    const useSearch = config.get(['search', 'enabled']);
    const sessionId = (session && session.sessionId) || 'default';
    if (sessionStore.maxTurns === 0) sessionStore.init();

    // 多轮历史上下文
    const history = features.isEnabled('sessionMemory') ? sessionStore.getHistory(sessionId) : [];

    // 知识库检索
    let kbSnippets = [];
    if (useRag && kb.enabled) {
      try {
        kbSnippets = await kb.search(message, config.get(['rag','maxRefs']));
        logger.info('RAG 检索', { hits: kbSnippets.length });
      } catch (e) { logger.warn('RAG 检索失败', { error: e.message }); }
    }

    // 联网搜索
    let searchResults = [];
    if (useSearch) {
      try { searchResults = await searchTool.search(message); }
      catch (e) { logger.warn('搜索失败', { error: e.message }); }
    }

    // 角色人设
    const rolePrompt = roles.enabled && roles.selectedRole ? roles.renderSystemPrompt(roles.selectedRole) : '';

    // 风控：预估成本
    const estTokens = Math.max(500, Math.round((message.length + (rolePrompt?.length||0) + (kbSnippets.length*500)) / 2));
    risk.checkLimit(estTokens);

    // 构建系统提示
    const loadedSkills = skills.loadedContent ? skills.loadedContent() : '';
    const systemParts = [];
    if (rolePrompt) systemParts.push(rolePrompt);
    if (loadedSkills) systemParts.push('[已加载技能指令]\n' + loadedSkills);
    if (planMode.isActive()) systemParts.push(planMode.guidance());
    // RAG 片段注入系统提示
    if (kbSnippets.length) {
      systemParts.push('[知识库参考片段]\n' + kbSnippets.map((s, i) => `[${i+1}] ${s.snippet || ''}`).join('\n\n'));
    }
    // 搜索结果注入系统提示
    if (searchResults.length) {
      systemParts.push('[联网搜索结果]\n' + searchResults.map((r, i) => `[${i+1}] ${r.title || ''}: ${r.snippet || r.content || ''}`).join('\n\n'));
    }
    const systemPrompt = systemParts.join('\n\n');

    // 工具调用是否启用
    const toolsEnabled = toolRunner.isEnabled() && toolRunner.toolSchemas().length > 0;

    let result;
    let toolCalls = [];
    let reasoningText = '';

    if (toolsEnabled) {
      // 使用核心 Agent Loop（原生 function calling，任意深度，并行工具调用）
      const modelCfg = scheduler.eligibleModels()[0];
      if (!modelCfg) throw new Error('没有可用模型');

      const loopResult = await agentLoop.run({
        modelCfg,
        systemPrompt,
        userMessage: message,
        history,
        maxSteps: config.get(['agentLoop', 'maxSteps']) || 50,
        maxTokens: config.get(['agentLoop', 'maxTokens']) || 4096,
        temperature: (config.get(['think','temperature']) != null ? config.get(['think','temperature']) : null),
        topP: (config.get(['think','topP']) != null ? config.get(['think','topP']) : null),
        onThink: (text) => { reasoningText = text; }
      });

      result = {
        final: {
          text: loopResult.text,
          strategy: 'agent-loop',
          contributors: [modelCfg.id]
        },
        mode: loopResult.finished ? 'agent-loop' : 'agent-loop-incomplete',
        fromCache: false
      };
      toolCalls = loopResult.toolCalls || [];
      if (loopResult.reasoning) reasoningText = loopResult.reasoning;
    } else {
      // 无工具：走合议/单模型路径
      const roleId = roles.enabled && roles.selectedRole ? roles.selectedRole.id : '';
      const basePrompt = history.length ? sessionStore.buildHistoryPrompt(sessionId) : '';
      result = await scheduler.deliberate({
        basePrompt: basePrompt + '\n\n' + systemPrompt,
        userMsg: message,
        rolePrompt: history.length ? '' : rolePrompt,
        roleId,
        kbSnippets,
        searchResults,
        thinkLevel
      });
    }

    // 记录消费
    risk.record({ tokens: estTokens, modelId: result.results?.[0]?.modelId, cost: risk.estimateCost(estTokens, result.results?.[0]?.modelId) });

    // 追加到会话历史
    if (features.isEnabled('sessionMemory')) {
      const isNew = !sessionStore.getHistory(sessionId).length;
      sessionStore.push(sessionId, message, result.final.text, { meta: toolCalls.length ? { toolCalls } : undefined });
      // 新会话：异步使用 LLM 生成更智能的标题（不阻塞）
      if (isNew) {
        sessionStore.generateTitle(sessionId, message).catch(() => {});
      }
    }
    if (toolCalls.length) sessionStore.recordEvent(sessionId, 'turn/tool_calls', { toolCalls });

    return {
      text: result.final.text,
      strategy: result.final.strategy,
      contributors: result.final.contributors || [],
      fromCache: result.fromCache,
      kbHits: kbSnippets.length,
      searchHits: searchResults.length,
      mode: result.mode,
      sessionId,
      toolCalls,
      reasoning: reasoningText || undefined
    };
  }
}

module.exports = new ChatService();
