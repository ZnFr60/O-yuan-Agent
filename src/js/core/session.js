// session.js - 多轮会话上下文记忆 + 历史持久化
// 每个会话维护最近 N 轮对话历史，注入系统提示；并持久化到磁盘支持历史会话列表。
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class SessionStore {
  constructor() {
    this.sessions = new Map(); // sessionId -> { history, createdAt, updatedAt, title }
    this.maxTurns = 50;        // 保留最近多少轮（每轮含 user+assistant），可配置
    this.maxChars = 50000;     // 历史消息总字符上限，可配置
    this.storeFile = null;     // 持久化文件
  }

  init() {
    const c = config.get(['session']) || {};
    this.maxTurns = c.maxTurns || 50;
    this.maxChars = c.maxChars || 50000;
    // 持久化文件（logs/sessions.json，可配置自定义路径）
    const dir = c.dir ? config.resolveDir(c.dir) : config.resolveDir(path.join('logs'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.storeFile = path.join(dir, 'sessions.json');
    // 对话明文记录目录（logs/conversations/*.txt，人类可读的对话记录）
    this.dialogueDir = path.join(dir, 'conversations');
    if (!fs.existsSync(this.dialogueDir)) fs.mkdirSync(this.dialogueDir, { recursive: true });
    // 配置里可关闭明文对话记录
    this.saveDialogueTxt = c.dialogueTxt !== false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.storeFile)) {
        const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
        for (const [id, s] of Object.entries(raw)) {
          this.sessions.set(id, { history: s.history || [], createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now(), title: s.title || '' });
        }
        logger.info('会话历史已加载', { count: this.sessions.size });
      }
    } catch (e) { logger.warn('会话历史加载失败', { error: e.message }); }
  }

  save() {
    try {
      const out = {};
      for (const [id, s] of this.sessions) {
        out[id] = { history: s.history, createdAt: s.createdAt, updatedAt: s.updatedAt, title: s.title || '' };
      }
      fs.writeFileSync(this.storeFile, JSON.stringify(out, null, 1), 'utf8');
    } catch (e) { logger.warn('会话历史保存失败', { error: e.message }); }
  }

  // 从用户首条消息提取会话标题（启发式：截取前 40 字符）
  deriveTitle(msg) {
    const t = String(msg || '').replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 40) + '…' : (t || '新会话');
  }

  // 使用 LLM 生成更智能的会话标题（异步，不阻塞主流程）
  async generateTitle(sessionId, firstMessage) {
    try {
      // 延迟加载以避免循环依赖
      const scheduler = require('../deliberation/scheduler');
      const provider = require('../deliberation/provider');
      const models = scheduler.eligibleModels();
      if (!models.length) return null;
      const model = models[0];
      const msg = String(firstMessage || '').slice(0, 500);
      const res = await provider.call(model, [
        { role: 'system', content: '你是一个会话标题生成器。根据用户的第一条消息，生成一个简洁、准确的会话标题（不超过15个字，不要加引号，不要解释，直接输出标题）。' },
        { role: 'user', content: msg }
      ], { temperature: 0.3, maxTokens: 50, timeoutMs: 10000 });
      const title = (res.content || '').trim().replace(/^["'「『]+|["'」』]+$/g, '').slice(0, 40);
      if (title && title.length > 1) {
        const s = this.sessions.get(sessionId);
        if (s) { s.title = title; this.save(); }
        return title;
      }
    } catch (e) {
      logger.debug('LLM 生成标题失败，使用启发式标题', { error: e.message });
    }
    return null;
  }

  get(id) {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, { history: [], createdAt: Date.now(), updatedAt: Date.now(), title: '新会话' });
    }
    return this.sessions.get(id);
  }

  // 追加一轮；opts.meta 可携带工具调用轨迹等结构化信息（采用业界通用做法：事件日志：会话不仅存文本，还保留工具执行记录）
  // 同时把对话内容实时追加写入明文 txt 记录文件（logs/conversations/{id}.txt）
  push(id, userMsg, assistantText, opts = {}) {
    const s = this.get(id);
    if (!s.history.length && userMsg) s.title = this.deriveTitle(userMsg);
    s.history.push({ role: 'user', content: userMsg });
    s.history.push({
      role: 'assistant',
      content: assistantText,
      ...(opts.meta ? { meta: opts.meta } : {})
    });
    s.updatedAt = Date.now();
    // 裁剪：只保留最近 maxTurns 轮，并按字符上限压缩
    this.trim(s);
    this.save();
    // 追加对话到明文 txt 文件
    if (this.saveDialogueTxt) this.appendDialogueTxt(id, userMsg, assistantText);
    return s.history;
  }

  // 把一轮对话追加到明文 txt 记录文件（人类可读）
  appendDialogueTxt(id, userMsg, assistantText) {
    try {
      if (this.dialogueDir == null) return;
      const file = path.join(this.dialogueDir, String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt');
      const ts = new Date().toLocaleString('zh-CN', { hour12: false });
      const line = '[' + ts + ']\n用户: ' + String(userMsg || '') + '\n助手: ' + String(assistantText || '') + '\n\n';
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) {
      logger.warn('对话 txt 写入失败', { error: e.message });
    }
  }

  // 读取某会话的明文对话 txt 内容
  getDialogueTxt(id) {
    try {
      if (this.dialogueDir == null) return '';
      const file = path.join(this.dialogueDir, String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    } catch (e) { return ''; }
  }

  // 记录一条结构化会话事件（如工具调用、turn 边界），供回放/审计。采用业界通用做法：append-only SessionEvent log。
  recordEvent(id, type, data = {}) {
    const s = this.get(id);
    if (!s.events) s.events = [];
    s.events.push({ type, data, ts: Date.now() });
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200); // 限长
    this.save();
    return s.events.length;
  }

  // 读取某会话的全部事件（工具轨迹/边界），供回放或前端展示
  getEvents(id) {
    const s = this.get(id);
    return s.events || [];
  }

  // 会话列表（按更新时间倒序），供历史侧栏展示
  list() {
    const arr = Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      title: s.title || '新会话',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      turns: Math.round(s.history.length / 2)
    }));
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
    // 按日期分组：今天/昨天/更早
    const groups = [];
    const today = new Date(); today.setHours(0,0,0,0);
    const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    const groupFor = (ts) => {
      const d = new Date(ts); d.setHours(0,0,0,0);
      if (d.getTime() === today.getTime()) return '今天';
      if (d.getTime() === yest.getTime()) return '昨天';
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    };
    const map = {};
    for (const s of arr) {
      const g = groupFor(s.updatedAt);
      if (!map[g]) { map[g] = []; groups.push({ group: g, sessions: map[g] }); }
      map[g].push(s);
    }
    return groups;
  }

  getHistory(id) {
    const s = this.get(id);
    return s.history;
  }

  // 上下文压缩（采用业界通用做法：compaction）：超长历史不粗暴丢弃，而是把最旧部分压缩成摘要块，
  // 保留信息量，节省 token。摘要用启发式生成（提取每轮要点），不依赖额外 LLM 调用。
  trim(s) {
    // 1) 按轮数上限：超出部分压缩为摘要
    if (s.history.length > this.maxTurns * 2) {
      const overflow = s.history.length - this.maxTurns * 2;
      const old = s.history.splice(0, overflow);
      const summary = this._buildSummary(old);
      if (summary) s.history.unshift({ role: 'user', content: '[历史摘要]\n' + summary });
    }
    // 2) 字符上限：从最旧部分压缩
    let total = 0;
    const counts = s.history.map(h => String(h.content || '').length);
    let drop = -1;
    for (let i = counts.length - 1; i >= 0; i--) {
      total += counts[i];
      if (total > this.maxChars && drop < 0) drop = i;
    }
    if (drop > 0) {
      const old = s.history.splice(0, drop);
      const summary = this._buildSummary(old);
      if (summary) s.history.unshift({ role: 'user', content: '[历史摘要]\n' + summary });
    }
  }

  // 启发式摘要：从旧消息提取每轮要点，保留用户消息完整意图和助手关键结论
  _buildSummary(messages) {
    if (!messages || !messages.length) return '';
    const lines = [];
    for (const m of messages) {
      const text = String(m.content || '').trim().replace(/\s+/g, ' ');
      if (!text || text === '[历史摘要]') continue;
      // 用户消息保留更多（完整意图），助手消息保留关键结论
      const maxLen = m.role === 'user' ? 500 : 300;
      const snippet = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
      lines.push((m.role === 'user' ? '问: ' : '答: ') + snippet);
      if (lines.length >= 60) break;
    }
    return lines.join('\n');
  }

  // 生成注入系统提示的历史上下文块（不截断单条消息，保留完整内容）
  buildHistoryPrompt(id) {
    const s = this.get(id);
    if (!s.history.length) return '';
    let lines = '[对话历史]\n';
    for (const h of s.history) {
      const content = String(h.content || '');
      // 单条消息最多保留 3000 字符，超长的标注截断
      const truncated = content.length > 3000;
      const text = truncated ? content.slice(0, 3000) + '\n...[消息过长已截断，总长 ' + content.length + ' 字符]' : content;
      lines += (h.role === 'user' ? '用户: ' : '助手: ') + text + '\n';
    }
    return lines;
  }

  clear(id) { this.sessions.delete(id); this.save(); }
  rename(id, title) {
    const s = this.get(id);
    if (title) s.title = String(title).slice(0, 40);
    this.save();
    return s.title;
  }

  // 摘要统计
  stats() {
    let turns = 0;
    for (const s of this.sessions.values()) turns += s.history.length / 2;
    return { activeSessions: this.sessions.size, totalTurns: Math.round(turns) };
  }
}

module.exports = new SessionStore();
