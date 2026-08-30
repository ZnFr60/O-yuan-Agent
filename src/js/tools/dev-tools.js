// dev-tools.js - 开发工具集（Git + Todo）
// Git 操作工具和任务管理工具。
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

// ==================== Git 工具 ====================

function gitExec(args, cwd) {
  permissions.require('execAdvancedShell');
  const dir = cwd ? (path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd)) : process.cwd();
  try {
    const result = execSync('git ' + args.join(' '), {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, output: result.trim(), cwd: dir };
  } catch (e) {
    return { ok: false, error: e.message, stderr: e.stderr ? e.stderr.toString().trim() : '', cwd: dir };
  }
}

const gitTools = {
  // git status
  status: (cwd) => gitExec(['status', '--short', '--branch'], cwd),
  // git log
  log: (cwd, count = 20) => gitExec(['log', '--oneline', '-' + count, '--decorate'], cwd),
  // git diff
  diff: (cwd, file = null) => gitExec(file ? ['diff', '--', file] : ['diff'], cwd),
  // git add
  add: (cwd, files) => gitExec(['add', ...(Array.isArray(files) ? files : [files])], cwd),
  // git commit
  commit: (cwd, message) => gitExec(['commit', '-m', '"' + message.replace(/"/g, '\\"') + '"'], cwd),
  // git branch
  branch: (cwd) => gitExec(['branch', '-a', '-v'], cwd),
  // git checkout
  checkout: (cwd, branch) => gitExec(['checkout', branch], cwd),
  // git pull
  pull: (cwd) => gitExec(['pull'], cwd),
  // git push
  push: (cwd) => gitExec(['push'], cwd),
  // git clone
  clone: (cwd, repo, target = null) => gitExec(target ? ['clone', repo, target] : ['clone', repo], cwd),
  // git remote
  remote: (cwd) => gitExec(['remote', '-v'], cwd),
  // git show (查看某个 commit 的内容)
  show: (cwd, commit) => gitExec(['show', '--stat', commit], cwd),
  // git blame
  blame: (cwd, file) => gitExec(['blame', '--', file], cwd)
};

// ==================== Todo 工具 ====================
// 参考 DSH todo/tool-todo 设计：任务清单管理，支持增删改查、状态切换。

const todoFile = path.join(process.cwd(), '.oyuan-todo.json');

function loadTodos() {
  try {
    if (fs.existsSync(todoFile)) {
      return JSON.parse(fs.readFileSync(todoFile, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { tasks: [], nextId: 1 };
}

function saveTodos(data) {
  try {
    fs.writeFileSync(todoFile, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

const todoTools = {
  // 列出所有任务
  list: (filter = null) => {
    const data = loadTodos();
    let tasks = data.tasks;
    if (filter === 'done') tasks = tasks.filter(t => t.done);
    if (filter === 'pending') tasks = tasks.filter(t => !t.done);
    return { ok: true, tasks, total: data.tasks.length, pending: data.tasks.filter(t => !t.done).length, done: data.tasks.filter(t => t.done).length };
  },
  // 添加任务
  add: (title, description = '') => {
    const data = loadTodos();
    const task = {
      id: data.nextId++,
      title: String(title),
      description: String(description || ''),
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    data.tasks.push(task);
    saveTodos(data);
    return { ok: true, task, total: data.tasks.length };
  },
  // 标记完成/未完成
  toggle: (id) => {
    const data = loadTodos();
    const task = data.tasks.find(t => t.id === Number(id));
    if (!task) return { ok: false, error: '任务不存在: ' + id };
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;
    saveTodos(data);
    return { ok: true, task };
  },
  // 更新任务
  update: (id, updates = {}) => {
    const data = loadTodos();
    const task = data.tasks.find(t => t.id === Number(id));
    if (!task) return { ok: false, error: '任务不存在: ' + id };
    if (updates.title != null) task.title = String(updates.title);
    if (updates.description != null) task.description = String(updates.description);
    saveTodos(data);
    return { ok: true, task };
  },
  // 删除任务
  remove: (id) => {
    const data = loadTodos();
    const idx = data.tasks.findIndex(t => t.id === Number(id));
    if (idx === -1) return { ok: false, error: '任务不存在: ' + id };
    const removed = data.tasks.splice(idx, 1)[0];
    saveTodos(data);
    return { ok: true, removed, total: data.tasks.length };
  },
  // 清除已完成任务
  clearDone: () => {
    const data = loadTodos();
    const removed = data.tasks.filter(t => t.done);
    data.tasks = data.tasks.filter(t => !t.done);
    saveTodos(data);
    return { ok: true, removed: removed.length, remaining: data.tasks.length };
  }
};

module.exports = { gitTools, todoTools };
