// tool-runner.js - 工具调用链（Agent Loop 核心）
// 把 Conclave 能力（GUI / 搜索 / 知识库）暴露为可调工具，
// 模型可请求调用，工具结果回填给模型继续推理。
'use strict';
const logger = require('../core/logger');
const permissions = require('../core/permissions');
const features = require('../core/features');
const config = require('../core/config');

const registry = {
  gui_screenshot: {
    desc: '截取当前电脑屏幕，返回PNG图像，用于查看界面状态',
    params: { region: '可选，截取区域 [x,y,w,h]' },
    needsPermission: 'guiControl',
    run: async (args) => {
      const gui = require('../tools/gui-automation');
      if (args && args.region) {
        const s = await gui.screencrop(args.region);
        return { width: s.width, height: s.height, png_base64: s.png_base64 || '', image: true, note: '图像已返回(base64)，可直接作为图像输入' };
      }
      const s = await gui.screenshot();
      return { width: s.width, height: s.height, png_base64: s.png_base64 || '', image: true, note: '图像已返回(base64)，可直接作为图像输入' };
    }
  },
  gui_mouse: {
    desc: '移动/点击鼠标。action: move|click|doubleClick|scroll|drag',
    params: { action: 'string', x: 'number', y: 'number', button: 'left|right|middle' },
    needsPermission: 'guiControl',
    run: async (args) => {
      const gui = require('../tools/gui-automation');
      return gui.mouse(args.action, args);
    }
  },
  gui_keyboard: {
    desc: '键盘输入。action: type|press|hotkey|write(支持中文)',
    params: { action: 'string', text: 'string', combo: 'string', keys: 'array' },
    needsPermission: 'guiControl',
    run: async (args) => {
      const gui = require('../tools/gui-automation');
      return gui.keyboard(args.action, args);
    }
  },
  web_search: {
    desc: '联网搜索，返回网页结果标题/链接/摘要',
    params: { query: 'string' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const search = require('../tools/search');
      return search.search(args.query);
    }
  },
  kb_query: {
    desc: '查询本地知识库，返回相关文档片段',
    params: { query: 'string', limit: 'number' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const kb = require('../core/kb');
      const r = await kb.search(args.query, args.limit);
      return r.map(x => ({ doc: x.docId, score: x.score, snippet: x.snippet }));
    }
  },
  run_command: {
    desc: '执行一条命令行命令并返回输出。当需要查看目录/文件、运行脚本、查询系统状态、修改文件等命令行任务时使用。参数: {command: "要执行的命令"}。',
    params: { command: 'string', workdir: 'string', timeoutMs: 'number' },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const cmd = require('../tools/command');
      return cmd.execute(args || {});
    }
  },
  subagent: {
    desc: '把独立任务委派给一个子代理执行并返回结果。当任务需要独立上下文、分头处理、或并行探索多个方向时使用。子代理可以调用大部分工具（除了subagent自身避免无限递归）。参数: {task: "给子代理的完整任务描述", description: "一句话说明", modelId: "可选指定模型", mode: "in-process(默认同进程)|isolated(独立进程隔离)", timeoutMs: "超时毫秒(默认300000)"}。',
    params: {
      task: { type: 'string', description: '给子代理的完整任务描述', required: true },
      description: { type: 'string', description: '一句话说明任务' },
      modelId: { type: 'string', description: '可选，指定模型 ID' },
      mode: { type: 'string', description: '运行模式: in-process(默认) 或 isolated(独立进程隔离)' },
      timeoutMs: { type: 'number', description: '超时时间（毫秒，默认 300000）' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const sub = require('../tools/subagent');
      return sub.run(args.task, args);
    }
  },
  workflow: {
    desc: '把一个复杂的多步骤任务编排成工作流执行。当任务可分解为多个独立子任务、且需要分阶段(可并行)处理时使用。参数: {plan: {name, description, phases: [{title, tasks: [{prompt, label, parallel}]}]}}，每个 tasks 里的 prompt 是一个独立子任务，parallel 为 true 时同阶段任务并行执行。',
    params: { plan: 'string' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const wf = require('../tools/workflow');
      let plan = args.plan;
      if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch (e) {} }
      return wf.run(plan || {}, args);
    }
  },
  exit_plan_mode: {
    desc: '仅在计划模式使用。把完整计划以markdown(以#标题开头)呈现给用户审查，用户批准后退出计划模式开始执行，或继续规划。参数: {plan: "完整执行计划(markdown)"}。',
    params: { plan: 'string' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const planMode = require('../core/plan-mode');
      return planMode.presentPlan(args.plan);
    }
  },
  load_skill: {
    desc: '加载一个技能（预定义的最佳实践指令模板），加载后技能指令会注入你的上下文，帮助你按最佳实践完成任务。参数: {name: "技能名"}。可用技能见 list_skills。',
    params: { name: 'string' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const skills = require('../core/skills');
      return skills.load(args.name);
    }
  },
  list_skills: {
    desc: '列出所有可用技能（内置 + 用户自定义），返回技能名、描述和使用场景。',
    params: {},
    needsPermission: 'fileRead',
    run: async () => {
      const skills = require('../core/skills');
      return { ok: true, skills: skills.list() };
    }
  },
  set_credential: {
    desc: '保存一个凭据（如API key、token）到安全凭据库。参数: {key: "凭据名(如 MY_API_KEY)", value: "凭据值"}。凭据加密存储，脱敏显示。',
    params: { key: 'string', value: 'string' },
    needsPermission: 'modifyConfig',
    run: async (args) => {
      const creds = require('../core/credentials');
      return creds.set(args.key, args.value);
    }
  },
  get_credential: {
    desc: '读取一个凭据的脱敏值（只显示前后几位，不泄露完整值）。参数: {key: "凭据名"}。',
    params: { key: 'string' },
    needsPermission: 'fileRead',
    run: async (args) => {
      const creds = require('../core/credentials');
      const masked = creds.mask(args.key);
      return { ok: masked != null, key: args.key, masked: masked || null, set: masked != null };
    }
  },
  list_credentials: {
    desc: '列出所有已保存凭据（只显示脱敏值）。',
    params: {},
    needsPermission: 'fileRead',
    run: async () => {
      const creds = require('../core/credentials');
      return { ok: true, credentials: creds.list() };
    }
  },
  // ---- 文件系统工具 ----
  read_file: {
    desc: '读取文件内容。支持大文件分块读取（offset/limit 按行）。参数: {path: "文件路径", offset: 起始行号(可选), limit: 读取行数(可选)}。',
    params: {
      path: { type: 'string', description: '文件路径（相对或绝对）', required: true },
      offset: { type: 'number', description: '起始行号（从1开始，可选）' },
      limit: { type: 'number', description: '读取行数（可选）' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.readFile(args.path, { offset: args.offset, limit: args.limit });
    }
  },
  write_file: {
    desc: '写入文件内容（覆盖已存在文件或新建文件）。参数: {path: "文件路径", content: "要写入的内容"}。',
    params: {
      path: { type: 'string', description: '文件路径（相对或绝对）', required: true },
      content: { type: 'string', description: '要写入的文件内容', required: true }
    },
    needsPermission: 'fileWrite',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.writeFile(args.path, args.content);
    }
  },
  edit_file: {
    desc: '精确字符串替换编辑文件。old_string 必须在文件中唯一匹配（包括空格和缩进），否则会报错。这是修改文件的推荐方式，比整文件重写更安全。参数: {path: "文件路径", old_string: "要替换的原文本", new_string: "替换后的新文本"}。',
    params: {
      path: { type: 'string', description: '文件路径', required: true },
      old_string: { type: 'string', description: '要替换的原文本（必须唯一匹配）', required: true },
      new_string: { type: 'string', description: '替换后的新文本', required: true }
    },
    needsPermission: 'fileWrite',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.editFile(args.path, args.old_string, args.new_string);
    }
  },
  search_files: {
    desc: '在目录或文件中搜索内容（grep）。支持正则表达式。参数: {pattern: "搜索模式(正则)", path: "搜索路径(默认当前目录)", include: "文件后缀过滤如 .js,.ts(可选)", exclude: "排除目录(可选)", caseSensitive: false(可选)}。',
    params: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）', required: true },
      path: { type: 'string', description: '搜索路径（默认当前目录）' },
      include: { type: 'string', description: '文件后缀过滤，如 .js,.ts' },
      exclude: { type: 'string', description: '排除目录名' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.searchFiles(args.pattern, args.path, {
        include: args.include ? args.include.split(',').map(s => s.trim()) : null,
        exclude: args.exclude ? args.exclude.split(',').map(s => s.trim()) : null,
        caseSensitive: args.caseSensitive
      });
    }
  },
  list_dir: {
    desc: '列出目录内容。参数: {path: "目录路径(默认当前目录)", showHidden: false(可选)}。',
    params: {
      path: { type: 'string', description: '目录路径（默认当前目录）' },
      showHidden: { type: 'boolean', description: '是否显示隐藏文件' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.listDir(args.path, { showHidden: args.showHidden });
    }
  },
  glob: {
    desc: '按 glob 模式匹配文件。支持 * (单级) 和 ** (任意路径) 通配符。参数: {pattern: "glob模式如 src/**/*.js", path: "搜索根目录(默认当前目录)"}。',
    params: {
      pattern: { type: 'string', description: 'glob 模式，如 src/**/*.js', required: true },
      path: { type: 'string', description: '搜索根目录（默认当前目录）' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const fs = require('./filesystem');
      return fs.globFiles(args.pattern, args.path);
    }
  },
  // ---- 持久化 Shell 工具 ----
  shell_exec: {
    desc: '在持久化 Shell 会话中执行命令。与 run_command 不同，持久化 shell 会保持工作目录、环境变量和 shell 状态，跨命令持续有效。这是执行多条相关命令的推荐方式。参数: {command: "要执行的命令", sessionId: "会话ID(可选，默认default)", timeoutMs: 超时毫秒(可选)}。',
    params: {
      command: { type: 'string', description: '要执行的 shell 命令', required: true },
      sessionId: { type: 'string', description: '持久化会话 ID（默认 default）' },
      timeoutMs: { type: 'number', description: '超时时间（毫秒，默认 60000）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const pshell = require('./persistent-shell');
      return pshell.execute(args.command, { sessionId: args.sessionId, timeoutMs: args.timeoutMs });
    }
  },
  shell_status: {
    desc: '查看持久化 Shell 会话状态。参数: {sessionId: "会话ID(可选)"}。不传则列出所有会话。',
    params: {
      sessionId: { type: 'string', description: '会话 ID（可选，不传则列出所有）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const pshell = require('./persistent-shell');
      if (args.sessionId) return pshell.status(args.sessionId);
      return { ok: true, sessions: pshell.list() };
    }
  },
  shell_cd: {
    desc: '切换持久化 Shell 的工作目录。参数: {path: "目标目录路径", sessionId: "会话ID(可选)"}。',
    params: {
      path: { type: 'string', description: '目标目录路径', required: true },
      sessionId: { type: 'string', description: '会话 ID（默认 default）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const pshell = require('./persistent-shell');
      return pshell.changeDir(args.path, args.sessionId);
    }
  },
  shell_close: {
    desc: '关闭持久化 Shell 会话。参数: {sessionId: "会话ID(可选)"}。不传则关闭所有会话。',
    params: {
      sessionId: { type: 'string', description: '会话 ID（可选，不传则关闭所有）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const pshell = require('./persistent-shell');
      if (args.sessionId) return pshell.close(args.sessionId);
      return pshell.closeAll();
    }
  },
  // ---- 代码运行时工具 ----
  run_code: {
    desc: '在隔离的子进程中执行代码。支持 Python 和 JavaScript。代码在独立进程中执行，不影响主进程。参数: {code: "要执行的代码", language: "python|javascript", timeoutMs: 超时毫秒(可选), cwd: 工作目录(可选)}。',
    params: {
      code: { type: 'string', description: '要执行的代码', required: true },
      language: { type: 'string', description: '编程语言: python 或 javascript', required: true },
      timeoutMs: { type: 'number', description: '超时时间（毫秒，默认 30000）' },
      cwd: { type: 'string', description: '工作目录（默认当前目录）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const runtime = require('./code-runtime');
      return runtime.runCode(args.code, args.language, { timeoutMs: args.timeoutMs, cwd: args.cwd });
    }
  },
  // ---- 网络工具 ----
  web_fetch: {
    desc: '获取网页内容。自动将 HTML 转为纯文本，JSON 自动格式化。参数: {url: "要获取的URL", raw: false(是否返回原始HTML), method: "GET|POST(可选)", body: "POST请求体(可选)"}。',
    params: {
      url: { type: 'string', description: '要获取的 URL', required: true },
      raw: { type: 'boolean', description: '是否返回原始 HTML（默认 false，自动转纯文本）' },
      method: { type: 'string', description: 'HTTP 方法（默认 GET）' },
      body: { type: 'string', description: 'POST 请求体（可选）' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const wf = require('./web-fetch');
      return wf.fetch(args.url, { raw: args.raw, method: args.method, body: args.body });
    }
  },
  // ---- Git 工具 ----
  git: {
    desc: 'Git 版本控制操作。action: status(状态)|log(日志)|diff(差异)|add(暂存)|commit(提交)|branch(分支)|checkout(切换分支)|pull(拉取)|push(推送)|remote(远程)|show(查看commit)|blame(追溯)。参数: {action: "操作类型", cwd: "仓库路径(可选)", file: "文件路径(用于diff/blame)", message: "提交信息(用于commit)", branch: "分支名(用于checkout)", files: "文件列表(用于add)", count: "日志条数(默认20)", repo: "仓库地址(用于clone)", target: "克隆目标目录(可选)"}。',
    params: {
      action: { type: 'string', description: 'Git 操作: status|log|diff|add|commit|branch|checkout|pull|push|remote|show|blame|clone', required: true },
      cwd: { type: 'string', description: '仓库路径（默认当前目录）' },
      file: { type: 'string', description: '文件路径（用于 diff/blame）' },
      message: { type: 'string', description: '提交信息（用于 commit）' },
      branch: { type: 'string', description: '分支名（用于 checkout）' },
      files: { type: 'string', description: '要暂存的文件，逗号分隔（用于 add）' },
      count: { type: 'number', description: '日志条数（默认 20）' },
      repo: { type: 'string', description: '仓库地址（用于 clone）' },
      target: { type: 'string', description: '克隆目标目录（可选）' },
      commit: { type: 'string', description: 'commit hash（用于 show）' }
    },
    needsPermission: 'execAdvancedShell',
    run: async (args) => {
      const { gitTools } = require('./dev-tools');
      const action = args.action;
      const cwd = args.cwd;
      switch (action) {
        case 'status': return gitTools.status(cwd);
        case 'log': return gitTools.log(cwd, args.count || 20);
        case 'diff': return gitTools.diff(cwd, args.file);
        case 'add': return gitTools.add(cwd, args.files ? args.files.split(',').map(s => s.trim()) : '.');
        case 'commit': return args.message ? gitTools.commit(cwd, args.message) : { ok: false, error: 'commit 需要 message 参数' };
        case 'branch': return gitTools.branch(cwd);
        case 'checkout': return args.branch ? gitTools.checkout(cwd, args.branch) : { ok: false, error: 'checkout 需要 branch 参数' };
        case 'pull': return gitTools.pull(cwd);
        case 'push': return gitTools.push(cwd);
        case 'remote': return gitTools.remote(cwd);
        case 'show': return args.commit ? gitTools.show(cwd, args.commit) : { ok: false, error: 'show 需要 commit 参数' };
        case 'blame': return args.file ? gitTools.blame(cwd, args.file) : { ok: false, error: 'blame 需要 file 参数' };
        case 'clone': return args.repo ? gitTools.clone(cwd, args.repo, args.target) : { ok: false, error: 'clone 需要 repo 参数' };
        default: return { ok: false, error: '未知 git 操作: ' + action + '。支持: status|log|diff|add|commit|branch|checkout|pull|push|remote|show|blame|clone' };
      }
    }
  },
  // ---- Todo 工具 ----
  todo: {
    desc: '任务清单管理。action: list(列出)|add(添加)|toggle(标记完成/未完成)|update(更新)|remove(删除)|clearDone(清除已完成)。参数: {action: "操作类型", title: "任务标题(用于add)", description: "任务描述(可选)", id: "任务ID(用于toggle/update/remove)", filter: "done|pending(用于list)"}。',
    params: {
      action: { type: 'string', description: '操作: list|add|toggle|update|remove|clearDone', required: true },
      title: { type: 'string', description: '任务标题（用于 add）' },
      description: { type: 'string', description: '任务描述（可选，用于 add/update）' },
      id: { type: 'number', description: '任务 ID（用于 toggle/update/remove）' },
      filter: { type: 'string', description: '过滤: done|pending（用于 list）' }
    },
    needsPermission: 'fileRead',
    run: async (args) => {
      const { todoTools } = require('./dev-tools');
      const action = args.action;
      switch (action) {
        case 'list': return todoTools.list(args.filter);
        case 'add': return args.title ? todoTools.add(args.title, args.description) : { ok: false, error: 'add 需要 title 参数' };
        case 'toggle': return args.id != null ? todoTools.toggle(args.id) : { ok: false, error: 'toggle 需要 id 参数' };
        case 'update': return args.id != null ? todoTools.update(args.id, { title: args.title, description: args.description }) : { ok: false, error: 'update 需要 id 参数' };
        case 'remove': return args.id != null ? todoTools.remove(args.id) : { ok: false, error: 'remove 需要 id 参数' };
        case 'clearDone': return todoTools.clearDone();
        default: return { ok: false, error: '未知 todo 操作: ' + action };
      }
    }
  }
};

// GUI 模式是否开启（聊天中可自动调用 GUI 工具）
function guiModeActive() {
  try {
    const c = config.get(['guiAgent']) || {};
    return !!c.enabled && c.mode !== 'none';
  } catch (e) { return false; }
}

function toolDescription() {
  if (!features.isEnabled('toolCalling')) return '';
  const lines = [];
  lines.push('你是一个可以调用工具的智能体。当需要执行命令/读写文件/运行脚本/查询系统、获取屏幕、搜索、查知识库时，用以下工具：');
  lines.push('请以 JSON 格式输出要调用的工具: {"tool":"工具名","args":{...}}');
  lines.push('');
  lines.push('【命令执行】当任务需要查看目录/文件内容、运行命令或脚本、查询系统状态时，用 run_command 工具，直接把要执行的命令放进 command 参数即可（如 {"tool":"run_command","args":{"command":"ls -la"}}）。命令输出会返回给你。');
  if (guiModeActive()) {
    lines.push('');
    lines.push('【GUI 模式已开启】你可以在普通对话中直接操作电脑屏幕：');
    lines.push('  1. 先调用 gui_screenshot 截取屏幕 —— 调用后你会收到截图图像，你能看到屏幕内容；');
    lines.push('  2. 基于看到的图像，用 gui_mouse 移动/点击（坐标是屏幕像素，如 500,400），用 gui_keyboard 输入文本；');
    lines.push('  3. 每步操作后可再次 gui_screenshot 确认效果，直到完成用户任务。');
    lines.push('  注意：当用户询问屏幕内容/需要看屏幕时，必须先调用 gui_screenshot；你能查看返回的图像。');
  }
  lines.push('可用工具:');
  for (const [name, t] of Object.entries(registry)) {
    lines.push('  - ' + name + ': ' + t.desc + ' (需要' + t.needsPermission + '权限)');
  }
  return lines.join('\n');
}

// 从参数描述推断 JSON Schema 类型
function inferType(desc) {
  const s = String(desc || '').toLowerCase();
  if (s.includes('array') || s.includes('列表') || s.includes('数组')) return 'array';
  if (s.includes('boolean') || s.includes('bool') || s.includes('是否') || s.includes('true/false')) return 'boolean';
  if (s.includes('number') || s.includes('int') || s.includes('float') || s.includes('数字') || s.includes('数量') || s.includes('上限')) return 'number';
  if (s.includes('object') || s.includes('对象') || s.includes('json')) return 'object';
  return 'string';
}

// 生成 OpenAI 兼容的原生 function calling 工具定义（JSON Schema）
// 支持两种参数定义：
//   1. 字符串描述（兼容）：{ command: '要执行的命令' }
//   2. 对象定义（推荐）：{ command: { type: 'string', description: '要执行的命令', required: true } }
function toolSchemas() {
  if (!features.isEnabled('toolCalling')) return [];
  return Object.entries(registry).map(([name, t]) => {
    const entries = Object.entries(t.params || {});
    const properties = {};
    const required = [];
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      let schema;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 对象定义
        schema = {
          type: v.type || inferType(v.description || ''),
          description: v.description || ''
        };
        if (v.enum) schema.enum = v.enum;
        if (v.default != null) schema.default = v.default;
        if (v.required) required.push(k);
      } else {
        // 字符串描述（兼容）
        const type = inferType(v);
        schema = { type, description: String(v) };
        // 第一个参数默认必填（核心参数，如 command/query）
        if (i === 0) required.push(k);
      }
      properties[k] = schema;
    }
    return {
      type: 'function',
      function: {
        name,
        description: t.desc,
        parameters: { type: 'object', properties, required }
      }
    };
  });
}

async function executeTool(name, args) {
  const tool = registry[name];
  if (!tool) return { ok: false, error: '未知工具: ' + name };
  if (tool.needsPermission && !permissions.can(tool.needsPermission)) {
    return { ok: false, error: '权限不足: ' + name + ' 需要 ' + tool.needsPermission + '(当前' + permissions.effective + ')' };
  }
  try {
    const result = await tool.run(args || {});
    logger.info('工具调用成功', { tool: name });
    return { ok: true, result };
  } catch (e) {
    logger.warn('工具调用失败', { tool: name, error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = { registry, toolDescription, toolSchemas, executeTool, isEnabled: () => features.isEnabled('toolCalling') };
