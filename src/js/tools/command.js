// command.js - 命令执行工具（服从三级权限，平台感知 shell）
// 开发者导向：无沙箱、无危险命令审批，仅靠权限等级控制执行范围。
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

// none 权限下的安全命令白名单（首词匹配，仅允许只读/无害操作）
const SAFE_COMMANDS = new Set([
  'pwd', 'ls', 'dir', 'echo', 'whoami', 'hostname', 'date', 'time',
  'cat', 'type', 'more', 'less', 'head', 'tail', 'find', 'grep', 'where',
  'which', 'printenv', 'env', 'git status', 'git log', 'git diff'
]);

// 平台感知的 shell：Windows=PowerShell，Linux/macOS=bash -c
function shellInvocation() {
  const isWin = os.platform() === 'win32';
  if (isWin) {
    return {
      file: 'powershell.exe',
      args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd]
    };
  }
  return {
    file: '/bin/bash',
    args: (cmd) => ['-c', cmd]
  };
}

// none 权限：判断是否安全命令（按命令首词匹配白名单）
function isSafeCommand(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  if (SAFE_COMMANDS.has(first)) return true;
  // 允许形如 "git status" 这类子命令（取前两个词）
  const two = String(command || '').trim().split(/\s+/).slice(0, 2).join(' ');
  return SAFE_COMMANDS.has(two);
}

class CommandTool {
  // 权限校验：返回允许的权限档位描述，或抛错
  requirePermission(command) {
    const level = permissions.getLevel();
    if (permissions.can('execCommand')) return { level, tier: 'full' };
    if (permissions.can('execAdvancedShell')) return { level, tier: 'advanced' };
    if (permissions.can('execSafeCommand')) {
      if (!isSafeCommand(command)) {
        throw new Error('权限不足：当前为[' + level + ']权限，仅允许安全命令(如 ls/dir/cat/pwd)。该命令需中等权限(advanced shell)。');
      }
      return { level, tier: 'safe' };
    }
    throw new Error('权限不足：当前权限不允许执行任何命令');
  }

  // 执行命令，返回 { ok, stdout, stderr, exitCode, timedOut }
  run(command, opts = {}) {
    return new Promise((resolve) => {
      const { workdir, timeoutMs } = opts;
      const shell = shellInvocation();
      const timeout = (timeoutMs && timeoutMs > 0) ? timeoutMs : 60000;
      const cwd = workdir ? path.resolve(workdir) : undefined;
      const proc = spawn(shell.file, shell.args(command), { cwd, windowsHide: true, env: process.env });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch (e) {} }, timeout);
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: '无法启动 shell: ' + err.message, exitCode: -1, timedOut });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        const text = stdout.length > 4000 ? stdout.slice(0, 4000) + '\n...[输出过长已截断, 总长 ' + stdout.length + ' 字符]' : stdout;
        resolve({ ok: true, stdout: text, stderr: stderr.slice(0, 2000), exitCode: code, timedOut });
      });
    });
  }

  // 供工具注册表调用的入口：返回统一结果对象
  async execute(args) {
    const command = String(args.command || '').trim();
    if (!command) return { ok: false, error: 'command 不能为空' };
    let perm;
    try { perm = this.requirePermission(command); }
    catch (e) { logger.warn('命令权限拒绝', { command: command.slice(0, 60), error: e.message }); return { ok: false, error: e.message }; }
    logger.info('执行命令', { tier: perm.tier, command: command.slice(0, 80) });
    const res = await this.run(command, { workdir: args.workdir, timeoutMs: args.timeoutMs });
    return {
      ok: res.ok,
      result: {
        stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode,
        timedOut: res.timedOut, tier: perm.tier
      },
      ...(res.error ? { error: res.error } : {})
    };
  }
}

module.exports = new CommandTool();
