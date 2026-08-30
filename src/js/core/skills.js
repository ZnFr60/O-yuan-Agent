// skills.js - 技能系统（采用业界通用做法：skill）
// 技能是可加载的预定义指令模板（markdown），模型通过 load_skill 加载指定技能，
// 把技能指令注入上下文，从而按最佳实践完成任务。
// 技能存储：内置技能 + 用户技能目录(config/skills/*.md)。
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// 内置技能（name/description/whenToUse/content）
const BUILTIN_SKILLS = {
  'code-review': {
    name: 'code-review',
    description: '代码审查：系统检查代码质量、bug、安全与可维护性',
    whenToUse: '当需要审查代码、发现 bug、检查安全问题时使用',
    content: [
      '# 代码审查技能',
      '请按以下维度系统审查代码：',
      '1. 正确性：逻辑错误、边界条件、资源泄漏',
      '2. 安全性：注入、路径穿越、敏感信息泄露、危险命令',
      '3. 性能：复杂度、不必要的同步、内存占用',
      '4. 可维护性：命名、重复、单一职责、错误处理',
      '5. 兼容性：跨平台（Windows/Linux/macOS）差异',
      '输出：按严重程度(高/中/低)列出问题，每个给出行号、问题、建议修复。',
      '最后给出总体评价(通过/需修改)和修改建议。'
    ].join('\n')
  },
  'doc-gen': {
    name: 'doc-gen',
    description: '文档生成：为代码/项目生成规范的中英双语文档',
    whenToUse: '当需要为代码、API、项目生成 README 或文档时使用',
    content: [
      '# 文档生成技能',
      '请按以下结构生成文档（中英双语）：',
      '1. 标题和一句话简介',
      '2. 功能特性列表',
      '3. 安装与使用说明（含命令示例）',
      '4. 配置说明',
      '5. 项目结构',
      '6. License 与贡献说明',
      '要求：代码块用语言标记；命令用真实可执行；保持简洁清晰。'
    ].join('\n')
  },
  'debug': {
    name: 'debug',
    description: '系统调试：定位并修复错误，分步验证',
    whenToUse: '当遇到错误、异常、运行失败需要定位根因时使用',
    content: [
      '# 系统调试技能',
      '请按以下流程排查问题：',
      '1. 复现：确认触发条件，记录完整错误信息（含堆栈）',
      '2. 定位：检查日志、配置文件、相关代码，缩小范围',
      '3. 假设：提出最可能的根因（多假设优先验证概率高的）',
      '4. 修复：给出修复方案，注意跨平台兼容',
      '5. 验证：运行测试/命令确认修复有效，回归检查',
      '输出每个步骤的结论和证据。'
    ].join('\n')
  }
};

class Skills {
  constructor() {
    this.loadedSkills = new Map(); // name -> content（本次会话已加载）
    this.userDir = null;
  }

  init() {
    this.userDir = config.resolveDir(path.join('config', 'skills'));
    if (!fs.existsSync(this.userDir)) fs.mkdirSync(this.userDir, { recursive: true });
  }

  // 列出所有可用技能（内置 + 用户目录）
  list() {
    const result = Object.values(BUILTIN_SKILLS).map(s => ({ name: s.name, description: s.description, whenToUse: s.whenToUse, source: 'builtin' }));
    try {
      if (fs.existsSync(this.userDir)) {
        for (const f of fs.readdirSync(this.userDir)) {
          if (!f.endsWith('.md')) continue;
          const name = f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const content = fs.readFileSync(path.join(this.userDir, f), 'utf8');
          const firstLine = content.split('\n').find(l => l.trim());
          result.push({ name, description: firstLine ? firstLine.replace(/^#\s*/, '') : f, source: 'user' });
        }
      }
    } catch (e) { logger.warn('读取用户技能目录失败', { error: e.message }); }
    return result;
  }

  // 加载一个技能，返回其完整指令内容
  load(name) {
    const key = String(name || '').toLowerCase();
    if (BUILTIN_SKILLS[key]) {
      this.loadedSkills.set(key, BUILTIN_SKILLS[key].content);
      return { ok: true, name: key, description: BUILTIN_SKILLS[key].description, content: BUILTIN_SKILLS[key].content };
    }
    // 尝试用户技能目录
    try {
      const userFile = path.join(this.userDir, key + '.md');
      if (fs.existsSync(userFile)) {
        const content = fs.readFileSync(userFile, 'utf8');
        this.loadedSkills.set(key, content);
        return { ok: true, name: key, content, source: 'user' };
      }
    } catch (e) {}
    return { ok: false, error: '未找到技能: ' + name };
  }

  // 本次会话已加载的技能指令（拼接注入上下文）
  loadedContent() {
    return Array.from(this.loadedSkills.values()).join('\n\n');
  }

  // 当前已加载技能名
  loadedNames() { return Array.from(this.loadedSkills.keys()); }

  clear() { this.loadedSkills.clear(); }
}

module.exports = new Skills();
