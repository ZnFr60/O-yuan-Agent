// credentials.js - 凭据管理（采用业界通用做法：credentials）
// 集中存储敏感凭据（API key、token 等），支持读写、脱敏展示。
// 存储：config/credentials.json（含 gitignore 保护）。
// 提供 get/set/list，供模型工具(get_credential/set_credential)及内部使用。
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

class CredentialStore {
  constructor() {
    this.data = {};      // key -> value
    this.file = null;
  }

  init() {
    const dir = config.resolveDir(path.join('config'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'credentials.json');
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
        logger.info('凭据已加载', { count: Object.keys(this.data).length });
      }
    } catch (e) { logger.warn('凭据加载失败', { error: e.message }); this.data = {}; }
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8'); }
    catch (e) { logger.warn('凭据保存失败', { error: e.message }); }
  }

  // 设置凭据，返回脱敏后的确认
  set(key, value) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: '凭据名不能为空' };
    if (value == null) {
      delete this.data[k];
      this.save();
      return { ok: true, key: k, set: false, masked: this.mask(k) };
    }
    this.data[k] = String(value);
    this.save();
    logger.info('凭据已设置', { key: k, len: String(value).length });
    return { ok: true, key: k, set: true, masked: this.mask(k) };
  }

  // 读取凭据（真实值，仅供内部/受信调用）
  get(key) {
    return this.data[String(key || '')];
  }

  // 脱敏展示一个凭据值
  mask(key) {
    const v = this.data[String(key || '')];
    if (v == null) return undefined;
    return this.maskValue(v);
  }

  maskValue(v) {
    const s = String(v);
    if (s.length <= 4) return '***';
    return s.slice(0, 3) + '***' + s.slice(-3);
  }

  // 列出所有凭据名 + 脱敏值（不泄露真实值）
  list() {
    return Object.entries(this.data).map(([key, value]) => ({
      key, masked: this.maskValue(value), length: String(value).length, set: true
    }));
  }

  // 删除凭据
  remove(key) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: '凭据名不能为空' };
    const existed = Object.prototype.hasOwnProperty.call(this.data, k);
    delete this.data[k];
    this.save();
    return { ok: true, removed: existed };
  }

  // 是否存在
  has(key) { return Object.prototype.hasOwnProperty.call(this.data, String(key || '')); }
}

module.exports = new CredentialStore();
