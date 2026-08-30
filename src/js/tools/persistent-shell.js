// persistent-shell.js - 持久化 Shell 会话
// 保持长期运行的 shell 进程，跨命令保持工作目录、环境变量、shell 状态。
// 参考 Claude Code persistent bash + DSH tool-bash-persistent 设计。
// 支持多个独立会话（按 sessionId 区分），Windows=PowerShell，Linux/macOS=bash。
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

const sessions = new Map(); // sessionId -> { proc, stdoutBuf, stderrBuf, busy, lastCommand, cwd }
const DEFAULT_TIMEOUT = 60000;
const MAX_OUTPUT = 50000; // 单次命令最大输出字符数

function shellCommand() {
  if (os.platform() === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-NoExit', '-Command', '-'] };
  }
  return { file: '/bin/bash', args: ['--noediting', '-i'] };
}

// 标记命令结束的分隔符（唯一字符串，用于判断命令执行完毕）
function endMarker(sessionId) {
  return '__OYUAN_SHELL_END_' + sessionId + '_' + Date.now() + '__';
}

class PersistentShell {
  // 获取或创建一个持久化 shell 会话
  getSession(sessionId = 'default') {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    permissions.require('execAdvancedShell');
    const shell = shellCommand();
    logger.info('创建持久化 Shell 会话', { sessionId, shell: shell.file });

    const proc = spawn(shell.file, shell.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const session = {
      proc,
      stdoutBuf: '',
      stderrBuf: '',
      busy: false,
      lastCommand: null,
      cwd: process.cwd(),
      createdAt: Date.now(),
      commandCount: 0
    };

    proc.stdout.on('data', (d) => {
      session.stdoutBuf += d.toString();
    });
    proc.stderr.on('data', (d) => {
      session.stderrBuf += d.toString();
    });
    proc.on('error', (err) => {
      logger.error('持久化 Shell 进程错误', { sessionId, error: err.message });
      sessions.delete(sessionId);
    });
    proc.on('close', (code) => {
      logger.info('持久化 Shell 会话关闭', { sessionId, code });
      sessions.delete(sessionId);
    });

    // 发送初始命令设置提示符（避免 shell 交互模式的噪音）
    if (os.platform() !== 'win32') {
      proc.stdin.write("export PS1=''\n");
      proc.stdin.write("stty -echo 2>/dev/null\n");
    }

    sessions.set(sessionId, session);
    return session;
  }

  // 在持久化 shell 中执行命令
  async execute(command, opts = {}) {
    const sessionId = opts.sessionId || 'default';
    const timeout = opts.timeoutMs || DEFAULT_TIMEOUT;
    const session = this.getSession(sessionId);

    if (session.busy) {
      return { ok: false, error: 'Shell 会话正忙，请等待上一条命令完成', sessionId };
    }

    session.busy = true;
    session.commandCount++;
    session.lastCommand = command;
    session.stdoutBuf = '';
    session.stderrBuf = '';

    const marker = endMarker(sessionId);
    const isWin = os.platform() === 'win32';

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时：发送 Ctrl+C 中断
        try {
          if (isWin) {
            session.proc.stdin.write('\u0003');
          } else {
            session.proc.stdin.write('\u0003');
          }
        } catch (e) { /* ignore */ }
        session.busy = false;
        resolve({
          ok: true,
          stdout: session.stdoutBuf.slice(0, MAX_OUTPUT),
          stderr: session.stderrBuf.slice(0, MAX_OUTPUT),
          timedOut: true,
          sessionId,
          cwd: session.cwd,
          commandCount: session.commandCount,
          note: '命令执行超时(' + (timeout / 1000) + 's)，已发送中断信号'
        });
      }, timeout);

      // 等待 marker 出现在 stdout 中，表示命令执行完毕
      const checkInterval = setInterval(() => {
        if (session.stdoutBuf.includes(marker) || session.stderrBuf.includes(marker)) {
          clearInterval(checkInterval);
          clearTimeout(timer);
          // 从输出中移除 marker
          let stdout = session.stdoutBuf.replace(marker, '').trim();
          let stderr = session.stderrBuf.replace(marker, '').trim();
          // 截断过长输出
          const stdoutTruncated = stdout.length > MAX_OUTPUT;
          const stderrTruncated = stderr.length > MAX_OUTPUT;
          if (stdoutTruncated) stdout = stdout.slice(0, MAX_OUTPUT) + '\n...[输出过长已截断，总长 ' + stdout.length + ' 字符]';
          if (stderrTruncated) stderr = stderr.slice(0, MAX_OUTPUT);

          session.busy = false;
          resolve({
            ok: true,
            stdout,
            stderr,
            timedOut: false,
            sessionId,
            cwd: session.cwd,
            commandCount: session.commandCount,
            stdoutTruncated,
            stderrTruncated
          });
        }
      }, 50);

      // 发送命令 + marker
      try {
        if (isWin) {
          // PowerShell：执行命令后输出 marker
          session.proc.stdin.write(command + '\n');
          session.proc.stdin.write("Write-Output '" + marker + "'\n");
        } else {
          // bash：执行命令（无论成功失败）后输出 marker
          session.proc.stdin.write(command + '\n');
          session.proc.stdin.write("echo '" + marker + "'\n");
        }
      } catch (e) {
        clearInterval(checkInterval);
        clearTimeout(timer);
        session.busy = false;
        resolve({ ok: false, error: '写入 shell 失败: ' + e.message, sessionId });
      }
    });
  }

  // 切换工作目录
  async changeDir(dir, sessionId = 'default') {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
    const result = await this.execute('cd "' + abs + '" && pwd', { sessionId });
    if (result.ok) session.cwd = abs;
    return result;
  }

  // 获取会话状态
  status(sessionId = 'default') {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: '会话不存在: ' + sessionId };
    return {
      ok: true,
      sessionId,
      busy: session.busy,
      cwd: session.cwd,
      commandCount: session.commandCount,
      lastCommand: session.lastCommand,
      createdAt: session.createdAt,
      pid: session.proc.pid
    };
  }

  // 列出所有会话
  list() {
    return Array.from(sessions.entries()).map(([id, s]) => ({
      sessionId: id,
      busy: s.busy,
      cwd: s.cwd,
      commandCount: s.commandCount,
      pid: s.proc.pid
    }));
  }

  // 关闭会话
  close(sessionId = 'default') {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: '会话不存在' };
    try { session.proc.kill(); } catch (e) { /* ignore */ }
    sessions.delete(sessionId);
    logger.info('关闭持久化 Shell 会话', { sessionId });
    return { ok: true, sessionId };
  }

  // 关闭所有会话
  closeAll() {
    for (const [id, s] of sessions.entries()) {
      try { s.proc.kill(); } catch (e) { /* ignore */ }
    }
    sessions.clear();
    return { ok: true, closed: sessions.size };
  }
}

module.exports = new PersistentShell();
