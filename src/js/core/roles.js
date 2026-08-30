// roles.js - 持久化自定义角色 (MD 角色档案)
// 读取 config/roles/*.md，解析标准字段并渲染为系统提示。
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const native = require('./native');
const logger = require('./logger');

const FIELD_KEYS = ['角色名称', '回答风格', '行为准则', '禁止行为', '背景设定', '形象', '语气', '问候语', '头像', 'system'];
// 兼容中英文字段（含自定义人格形象字段）
const FIELD_ALIAS = {
  '角色名称': 'name', '角色名': 'name', '名称': 'name', 'name': 'name',
  '回答风格': 'style', '风格': 'style', 'style': 'style',
  '行为准则': 'rules', '行为': 'rules', 'rules': 'rules',
  '禁止行为': 'forbidden', 'forbidden': 'forbidden', '禁止': 'forbidden',
  '背景设定': 'background', 'background': 'background',
  '形象': 'appearance', '人设形象': 'appearance', 'appearance': 'appearance', '形象设定': 'appearance',
  '语气': 'tone', '说话语气': 'tone', 'tone': 'tone',
  '问候语': 'greeting', '开场白': 'greeting', 'greeting': 'greeting',
  '头像': 'avatar', 'avatar': 'avatar', '头像图片': 'avatar',
  'system': 'system', '系统提示': 'system', '系统': 'system'
};

// 解析 MD 文件：支持
//   # 角色名称
//   直接内容行
//   ## 回答风格
//   ...段落
//   ---
//   以及 frontmatter: name: xx / style: xx
function parseRoleMd(content, file) {
  const role = { id: path.basename(file, '.md'), name: '', style: '', rules: '', forbidden: '', background: '', appearance: '', tone: '', greeting: '', avatar: '', system: '', raw: content };
  // frontmatter
  let body = content;
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^\s*([\w\u4e00-\u9fa5]+)\s*[:：]\s*(.+)\s*$/.exec(line);
      if (m) {
        const field = FIELD_ALIAS[(m[1] || '').trim().toLowerCase()] || FIELD_ALIAS[m[1].trim()];
        if (field && role[field] === '') role[field] = m[2].trim();
      }
    }
    body = content.slice(fm[0].length);
  }

  // 以 # 开头的行：首个 # 标题视为角色名称（除非它匹配字段名），后续 ## 视为字段节
  let currentField = 'system';
  let titleSeen = false;
  const sectionLines = { name: [], style: [], rules: [], forbidden: [], background: [], appearance: [], tone: [], greeting: [], avatar: [], system: [] };
  for (const line of body.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const t = heading[1].trim();
      const field = FIELD_ALIAS[t.toLowerCase()] || FIELD_ALIAS[t];
      if (field && field !== 'name') { currentField = field; }
      else if (field === 'name' && !role.name) { role.name = t; }
      else if (!titleSeen && !role.name) {
        // 第一个非字段的 # 标题 = 角色名称
        role.name = t;
        titleSeen = true;
      }
      else if (!field) {
        // 后续非字段标题，作为内容
        if (sectionLines[currentField]) sectionLines[currentField].push(t);
      }
    } else {
      if (sectionLines[currentField]) sectionLines[currentField].push(line);
    }
  }

  for (const f of Object.keys(sectionLines)) {
    if (sectionLines[f].length && !role[f]) role[f] = sectionLines[f].join('\n').trim();
  }
  if (!role.name && fm) {
    // 尝试从第一个 # 提取
    const m = /^\s*#\s+(.+)$/m.exec(body);
    if (m) role.name = m[1].trim();
  }
  if (!role.name) role.name = role.id;
  return role;
}

class RoleManager {
  constructor() {
    this.roles = [];
    this.enabled = true;
    this.selected = '';
    this.dir = null;
  }

  init() {
    this.dir = config.resolveDir(path.join('config', 'roles'));
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.reload();
  }

  reload() {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    this.roles = files.map((f) => {
      const full = path.join(this.dir, f);
      try { return parseRoleMd(fs.readFileSync(full, 'utf8'), f); }
      catch (e) { logger.warn('角色解析失败', { file: f, error: e.message }); return null; }
    }).filter(Boolean);
    // 默认"无角色"= 纯通用大模型（不自动选中任何角色，用户需要时自行选择）
    if (this.selected && !this.roles.find((r) => r.id === this.selected)) this.selected = '';
    return this.roles;
  }

  get selectedRole() {
    return this.roles.find((r) => r.id === this.selected) || null;
  }

  // 渲染为系统提示（调用 C++ 模板渲染；不可用则 JS 实现）
  renderSystemPrompt(role, extraVars = {}) {
    const api = native.api();
    if (!role) return '';
    const vars = {
      name: role.name,
      style: role.style,
      rules: role.rules,
      forbidden: role.forbidden,
      background: role.background,
      appearance: role.appearance,
      tone: role.tone,
      greeting: role.greeting,
      ...extraVars
    };
    // 组装人设模板
    let tmpl = '';
    if (role.name) tmpl += '你是 {name}。\n';
    if (role.appearance) tmpl += '形象设定：{appearance}\n';
    if (role.tone) tmpl += '说话语气：{tone}\n';
    if (role.style) tmpl += '回答风格：{style}\n';
    if (role.rules) tmpl += '行为准则：{rules}\n';
    if (role.forbidden) tmpl += '禁止行为：{forbidden}\n';
    if (role.background) tmpl += '背景设定：{background}\n';
    const rendered = typeof api.renderRoleTemplate === 'function'
      ? api.renderRoleTemplate(tmpl, vars)
      : Object.entries(vars).reduce((acc, [k, v]) => acc.split('{' + k + '}').join(v), tmpl);
    return rendered.trim();
  }

  // AI 角色生成器：用户输入自然语言描述，模型整理为规范 MD 角色档案并保存。
  // 内部复用合议调度（走多模型），生成结果校验后写入 config/roles/*.md。
  async generateRole(description, session) {
    if (!description || !String(description).trim()) throw new Error('请描述你想要的角色');
    const scheduler = require('../deliberation/scheduler');
    const systemPrompt = '你是一个角色档案编辑器。用户会用自然语言描述一个想要的AI角色/人格。' +
      '请把它整理成一份规范的 Markdown 角色档案，包含以下字段（用中文标题）：' +
      '\n# <角色名称>\n## 形象\n## 语气\n## 问候语\n## 回答风格\n## 行为准则\n## 禁止行为\n## 背景设定\n\n' +
      '要求：\n1. 第一行 # 标题必须是角色实际名称（如 # 毒舌吐槽役），绝不能写"角色名称"这四个字。\n' +
      '2. 严格遵守上述字段格式，一个字段一个小节，字段标题用 ##。\n' +
      '3. 内容精炼具体，可直接作为系统提示使用。\n' +
      '4. 若用户描述未覆盖某字段，合理推断补充，不要留空。\n' +
      '5. 只输出 Markdown 本身，不要额外解释。';
    const result = await scheduler.deliberate({
      basePrompt: systemPrompt,
      userMsg: String(description),
      rolePrompt: '',
      kbSnippets: [],
      searchResults: [],
      thinkLevel: 6,
      skipCache: true
    });
    const md = String(result.final.text || '').trim();
    logger.info('AI角色生成原始输出', { len: md.length, head: md.slice(0, 120) });
    if (!md) throw new Error('模型未生成有效角色内容');
    // 解析生成的角色
    const parsed = parseRoleMd(md, 'generated.md');
    // 兜底：若标题是模板词"角色名称"，从紧随标题的非空行提取真实名称
    if (!parsed.name || parsed.name === 'generated' || parsed.name === '角色名称') {
      const m = /^#\s*角色名称\s*\n+([^#\n][^\n]*)/.exec(md);
      const fallbackName = m ? m[1].trim() : '';
      if (fallbackName && !/^##/.test(fallbackName)) {
        parsed.name = fallbackName.replace(/\(.+?\)/g, '').trim().slice(0, 30) || fallbackName;
      } else {
        throw new Error('生成的角色缺少名称，请换一种描述再试');
      }
    }
    // 写入文件
    const safe = parsed.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    const file = path.join(this.dir, safe + '.md');
    fs.writeFileSync(file, md, 'utf8');
    this.reload();
    // 自动选中生成的角色
    this.selected = safe;
    logger.info('AI生成角色', { name: parsed.name, file });
    return { file, role: parsed, name: parsed.name };
  }

  // 新建角色（支持自定义人格形象字段）
  createRole({ id, name, style, rules, forbidden, background, appearance, tone, greeting, avatar }) {
    const rid = id || name || ('role-' + Date.now());
    const safe = rid.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    const md = '# ' + (name || rid) + '\n\n'
      + (appearance ? '## 形象\n' + appearance + '\n\n' : '')
      + (tone ? '## 语气\n' + tone + '\n\n' : '')
      + (greeting ? '## 问候语\n' + greeting + '\n\n' : '')
      + (style ? '## 回答风格\n' + style + '\n\n' : '')
      + (rules ? '## 行为准则\n' + rules + '\n\n' : '')
      + (forbidden ? '## 禁止行为\n' + forbidden + '\n\n' : '')
      + (background ? '## 背景设定\n' + background + '\n' : '');
    const file = path.join(this.dir, safe + '.md');
    fs.writeFileSync(file, md, 'utf8');
    this.reload();
    return file;
  }

  updateRole(rid, updates) {
    const role = this.roles.find((r) => r.id === rid);
    if (!role) throw new Error('角色不存在: ' + rid);
    const file = path.join(this.dir, rid + '.md');
    const sec = (key, label) => {
      const v = updates[key] != null ? updates[key] : role[key];
      return v ? '## ' + label + '\n' + v + '\n\n' : '';
    };
    const md = '# ' + (updates.name || role.name) + '\n\n'
      + sec('appearance', '形象') + sec('tone', '语气') + sec('greeting', '问候语')
      + sec('style', '回答风格') + sec('rules', '行为准则') + sec('forbidden', '禁止行为')
      + sec('background', '背景设定');
    fs.writeFileSync(file, md, 'utf8');
    this.reload();
    return file;
  }

  // 返回当前角色的问候语（供 UI 展示）
  greeting() {
    const role = this.selectedRole;
    return role && role.greeting ? role.greeting : '';
  }

  deleteRole(rid) {
    const role = this.roles.find((r) => r.id === rid);
    if (!role) throw new Error('角色不存在: ' + rid);
    fs.unlinkSync(path.join(this.dir, rid + '.md'));
    if (this.selected === rid) this.selected = '';
    this.reload();
  }

  setEnabled(v) { this.enabled = !!v; }
  select(id) { if (this.roles.find((r) => r.id === id)) this.selected = id; }
}

module.exports = new RoleManager();
