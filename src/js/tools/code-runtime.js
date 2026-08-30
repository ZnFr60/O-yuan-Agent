// code-runtime.js - 代码运行时
// 在隔离的子进程中执行 Python / JavaScript 代码，返回执行结果。
// 参考 DSH code-runtime + code-runtime-python 设计。
// 开发者导向：无沙箱，仅靠权限等级控制。代码在独立子进程中执行，不影响主进程。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT = 20000;

// 创建临时文件写入代码
function writeTempFile(code, ext) {
  const dir = os.tmpdir();
  const file = path.join(dir, 'oyuan_code_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

// 执行 Python 代码
function runPython(code, opts = {}) {
  permissions.require('execAdvancedShell');
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT;
  const file = writeTempFile(code, 'py');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, [file], {
      cwd: opts.cwd || process.cwd(),
      env: process.env,
      windowsHide: true
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      cleanup();
      resolve({
        ok: false,
        language: 'python',
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: -1,
        timedOut: true,
        error: '执行超时(' + (timeout / 1000) + 's)'
      });
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }

    proc.on('error', (err) => {
      cleanup();
      resolve({ ok: false, language: 'python', error: '无法启动 Python: ' + err.message + '。请确保 Python 已安装并在 PATH 中。', exitCode: -1 });
    });
    proc.on('close', (code) => {
      cleanup();
      resolve({
        ok: code === 0,
        language: 'python',
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code,
        timedOut: false
      });
    });
  });
}

// 执行 JavaScript 代码（Node.js 子进程）
function runJavaScript(code, opts = {}) {
  permissions.require('execAdvancedShell');
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT;
  const file = writeTempFile(code, 'mjs');

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [file], {
      cwd: opts.cwd || process.cwd(),
      env: process.env,
      windowsHide: true
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      cleanup();
      resolve({
        ok: false,
        language: 'javascript',
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: -1,
        timedOut: true,
        error: '执行超时(' + (timeout / 1000) + 's)'
      });
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }

    proc.on('error', (err) => {
      cleanup();
      resolve({ ok: false, language: 'javascript', error: '无法启动 Node.js: ' + err.message, exitCode: -1 });
    });
    proc.on('close', (code) => {
      cleanup();
      resolve({
        ok: code === 0,
        language: 'javascript',
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code,
        timedOut: false
      });
    });
  });
}

// 统一入口：根据语言执行代码
async function runCode(code, language, opts = {}) {
  const lang = String(language || '').toLowerCase();
  if (lang === 'python' || lang === 'py') {
    return runPython(code, opts);
  }
  if (lang === 'javascript' || lang === 'js' || lang === 'node' || lang === 'nodejs') {
    return runJavaScript(code, opts);
  }
  return { ok: false, error: '不支持的语言: ' + language + '。支持: python, javascript' };
}

module.exports = {
  runCode,
  runPython,
  runJavaScript
};
