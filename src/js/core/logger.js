// logger.js - 分级滚动日志 + 敏感信息脱敏
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

// 敏感字段名集合（key 中包含这些关键词即脱敏）
const SENSITIVE_KEYS = ['apikey', 'api_key', 'password', 'secret', 'token', 'authorization', 'cookie', 'session'];

function mask(value) {
  const s = String(value);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

// 递归脱敏对象/数组
function sanitize(input, key = '') {
  if (input == null) return input;
  const isSensitive = SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k));
  if (typeof input === 'string') return isSensitive ? mask(input) : input;
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.map((v) => sanitize(v));
  if (typeof input === 'object') {
    const out = {};
    for (const k of Object.keys(input)) out[k] = sanitize(input[k], k);
    return out;
  }
  return input;
}

class Logger {
  constructor() {
    this.dir = null;
    this.level = 'INFO';
    this.maxSizeMB = 10;
    this.maxFiles = 5;
    this.currentStream = null;
    this.currentDate = null;
  }

  init() {
    const logCfg = config.get(['logging']) || {};
    this.dir = config.resolveDir(logCfg.dir || 'logs');
    this.level = logCfg.level || 'INFO';
    this.maxSizeMB = logCfg.maxSizeMB || 10;
    this.maxFiles = logCfg.maxFiles || 5;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this.roll();
  }

  logFile(dateStr) {
    return path.join(this.dir, 'app-' + dateStr + '.log');
  }

  roll() {
    const d = new Date();
    const ds = d.toISOString().slice(0, 10);
    if (this.currentStream && this.currentDate === ds) return;
    if (this.currentStream) { try { this.currentStream.end(); } catch (e) {} }
    this.currentDate = ds;
    const file = this.logFile(ds);
    this.currentStream = fs.createWriteStream(file, { flags: 'a' });
    this.rotateIfNeeded(file);
  }

  rotateIfNeeded(file) {
    try {
      const st = fs.statSync(file);
      if (st.size > this.maxSizeMB * 1024 * 1024) {
        const ts = Date.now();
        fs.renameSync(file, file + '.' + ts);
        this.prune();
      }
    } catch (e) {}
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const f of files.slice(this.maxFiles)) fs.unlinkSync(path.join(this.dir, f.f));
    } catch (e) {}
  }

  _write(level, msg, meta) {
    const threshold = LEVELS[this.level] || 20;
    if (LEVELS[level] < threshold) return;
    if (this.dir == null) {
      // 未初始化时的兜底：直接输出到控制台，避免模块在单测/独立加载时崩溃
      const ts = new Date().toISOString();
      const line = '[' + ts + '] [' + level + '] ' + msg + (meta !== undefined ? ' ' + JSON.stringify(sanitize(meta)) : '');
      if (level === 'ERROR') console.error(line);
      else if (level === 'WARN') console.warn(line);
      else console.log(line);
      return;
    }
    this.roll();
    const ts = new Date().toISOString();
    let line = '[' + ts + '] [' + level + '] ' + msg;
    if (meta !== undefined) line += ' ' + JSON.stringify(sanitize(meta));
    this.currentStream.write(line + '\n');
    // 控制台同步输出
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }

  debug(msg, meta) { this._write('DEBUG', msg, meta); }
  info(msg, meta) { this._write('INFO', msg, meta); }
  warn(msg, meta) { this._write('WARN', msg, meta); }
  error(msg, meta) { this._write('ERROR', msg, meta); }
}

module.exports = new Logger();
