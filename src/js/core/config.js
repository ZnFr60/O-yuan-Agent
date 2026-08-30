// config.js - 配置管理器
// 读取 config/config.json（不存在则从 config/config.default.json 生成），
// 所有路径使用 path 模块解析，兼容 Windows / Linux / macOS。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CFG_PATH = path.join(ROOT, 'config', 'config.default.json');
const CFG_PATH = path.join(ROOT, 'config', 'config.json');

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 3088,
    lanPasswordHash: '',
    lanPasswordRequired: true
  },
  deliberation: {
    mode: 'weighted',            // fast | equal | weighted | deep
    threshold: 0.5,
    faultBlacklistThreshold: 3,
    deepSummaryModel: 'primary'
  },
  models: [],
  think: {
    level: 5,                    // 0-10
    controlMode: 'native'        // native | prompt_override
  },
  cache: {
    enabled: true,
    maxSize: 500,
    ttlSeconds: 3600,
    whitelist: [],
    blacklist: []
  },
  permissions: {
    global: 'medium'             // none | medium | full
  },
  rag: {
    enabled: true,
    maxRefs: 3,
    kbPath: path.join('config', 'kb'),
    similarityThreshold: 0.25,
    chunkSize: 1000,
    chunkOverlap: 100
  },
  search: {
    enabled: false,
    provider: 'duckduckgo',
    maxResults: 5
  },
  risk: {
    dailyTokenLimit: 1000000,
    confirmCostThreshold: 0.02
  },
  taskQueue: {
    concurrency: 2,
    timeoutMs: 120000
  },
  logging: {
    level: 'INFO',               // DEBUG | INFO | WARN | ERROR
    dir: path.join('logs'),
    maxSizeMB: 10,
    maxFiles: 5
  },
  ui: {
    theme: 'dark',
    customBg: ''
  },
  plugins: {
    enabled: false,
    dir: path.join('plugins')
  }
};

function deepMerge(base, override) {
  if (override == null) return base;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) &&
        typeof override[k] === 'object' && !Array.isArray(override[k])) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

class ConfigManager {
  constructor() {
    this.data = null;
    this.fileWatchers = [];
  }

  load() {
    // 确保默认模板存在
    if (!fs.existsSync(DEFAULT_CFG_PATH)) {
      fs.writeFileSync(DEFAULT_CFG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    }
    let user = {};
    if (fs.existsSync(CFG_PATH)) {
      try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
      catch (e) { /* 保留默认 */ }
    } else {
      // 首次运行：从默认复制
      fs.copyFileSync(DEFAULT_CFG_PATH, CFG_PATH);
      user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    }
    this.data = deepMerge(DEFAULTS, user);
    return this.data;
  }

  get(pathArr) {
    let cur = this.data;
    for (const k of pathArr) { if (cur == null) return undefined; cur = cur[k]; }
    return cur;
  }

  set(pathArr, value) {
    let cur = this.data;
    for (let i = 0; i < pathArr.length - 1; ++i) {
      if (cur[pathArr[i]] == null) cur[pathArr[i]] = {};
      cur = cur[pathArr[i]];
    }
    cur[pathArr[pathArr.length - 1]] = value;
    this.save();
  }

  save() {
    fs.writeFileSync(CFG_PATH, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // 解析可能为绝对或相对路径的目录配置
  resolveDir(cfg) {
    return path.isAbsolute(cfg) ? cfg : path.join(ROOT, cfg);
  }

  root() { return ROOT; }
}

module.exports = new ConfigManager();
