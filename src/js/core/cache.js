// cache.js - 全局请求缓存 (LRU + TTL 混合淘汰)
// 使用 C++ 扩展做文本归一化哈希；不可用则回退 JS。
'use strict';
const crypto = require('crypto');
const native = require('./native');
const config = require('./config');
const logger = require('./logger');

const MAX_KEY_LEN = 512;

class CacheEntry {
  constructor(key, value, ttlMs) {
    this.key = key;
    this.value = value;
    this.expireAt = Date.now() + ttlMs;
    this.lastUsed = Date.now();
    this.hits = 0;
  }
  expired() { return Date.now() > this.expireAt; }
}

class LruTtlCache {
  constructor() {
    this.map = new Map();
    this.maxSize = 500;
    this.defaultTtlMs = 3600 * 1000;
    this.stats = { total: 0, hit: 0, miss: 0, evicted: 0, expired: 0, fuzzyHit: 0, hitsByKey: {} };
    this.storagePath = null;
    this.recentKeys = [];   // 最近请求 key 环形缓冲（用于语义模糊命中）
    this.fuzzyThreshold = 0.82;
  }

  init() {
    const c = config.get(['cache']) || {};
    this.maxSize = c.maxSize || 500;
    this.defaultTtlMs = (c.ttlSeconds || 3600) * 1000;
    this.enabled = c.enabled !== false;
    this.whitelist = c.whitelist || [];
    this.blacklist = c.blacklist || [];
    if (c.fuzzyThreshold != null) this.fuzzyThreshold = c.fuzzyThreshold;
  }

  // 记录最近 key（用于语义模糊命中）
  remember(key) {
    if (!this.recentKeys.includes(key)) {
      this.recentKeys.push(key);
      if (this.recentKeys.length > 64) this.recentKeys.shift();
    }
  }

  // 语义模糊命中：找到与当前 key 高度相似且已有缓存的最近 key
  fuzzyHit(key) {
    if (this.fuzzyThreshold >= 1) return null;
    const api = native.api();
    const sim = typeof api.cosineSimilarity === 'function' ? api.cosineSimilarity : null;
    if (!sim) return null;
    let best = null, bestScore = 0;
    for (const k of this.recentKeys) {
      if (k === key) continue;
      if (!this.map.has(k)) continue;
      let s;
      try { s = sim(k, key); } catch (e) { continue; }
      if (s > bestScore) { bestScore = s; best = k; }
    }
    if (best && bestScore >= this.fuzzyThreshold) {
      return { key: best, score: bestScore };
    }
    return null;
  }

  get hashImpl() {
    const api = native.api();
    return api.normalizedHash;
  }

  // 缓存 Key：归一化输入 + 角色 + 思考等级 + 知识库片段 + 合议配置
  buildKey({ input, role, thinkLevel, kbFragments, deliberationCfg }) {
    const parts = [
      typeof input === 'string' ? input : '',
      typeof role === 'string' ? role : '',
      String(thinkLevel == null ? '' : thinkLevel),
      Array.isArray(kbFragments) ? kbFragments.join('|') : '',
      typeof deliberationCfg === 'string' ? deliberationCfg : ''
    ];
    const joined = parts.join('::');
    const hashFn = this.hashImpl;
    const h = typeof hashFn === 'function' ? hashFn(joined) : crypto.createHash('sha256').update(joined).digest('hex').slice(0, 32);
    return h;
  }

  shouldUse(key) {
    if (!this.enabled) return false;
    // 黑名单优先
    if (this.blacklist.some((p) => key.includes(p))) return false;
    if (this.whitelist.length && !this.whitelist.some((p) => key.includes(p))) return false;
    return true;
  }

  get(key) {
    this.stats.total++;
    if (!this.enabled) { this.stats.miss++; return null; }
    let entry = this.map.get(key);
    if (!entry) {
      // 语义模糊命中：与最近相似请求共享结果
      const fh = this.fuzzyHit(key);
      if (fh) {
        entry = this.map.get(fh.key);
        if (entry) {
          this.stats.fuzzyHit++;
          this.stats.hit++;
          this.stats.hitsByKey[key] = (this.stats.hitsByKey[key] || 0) + 1;
          entry.hits++;
          entry.lastUsed = Date.now();
          return entry.value;
        }
      }
      this.stats.miss++;
      return null;
    }
    if (entry.expired()) {
      this.map.delete(key);
      this.stats.expired++;
      this.stats.miss++;
      return null;
    }
    entry.hits++;
    entry.lastUsed = Date.now();
    this.stats.hit++;
    this.stats.hitsByKey[key] = (this.stats.hitsByKey[key] || 0) + 1;
    // 更新为最近使用
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!this.enabled || this.map.size >= this.maxSize) this.evict();
    const ttl = ttlMs || this.defaultTtlMs;
    this.map.delete(key);
    this.map.set(key, new CacheEntry(key, value, ttl));
    this.remember(key);
  }

  evict() {
    // LRU：淘汰最久未使用；同时清理过期项
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expired()) { this.map.delete(k); this.stats.expired++; }
    }
    while (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.stats.evicted++;
    }
  }

  hitRate() {
    const { total, hit } = this.stats;
    return total ? hit / total : 0;
  }

  clear() { this.map.clear(); }

  snapshot() {
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      ...this.stats,
      hitRate: this.hitRate(),
      topKeys: Object.entries(this.stats.hitsByKey).sort((a, b) => b[1] - a[1]).slice(0, 10)
    };
  }

  // 导出备份
  exportBackup() {
    const data = [];
    for (const [k, v] of this.map) {
      data.push({ k, v, expireAt: v.expireAt });
    }
    return JSON.stringify({ exportedAt: Date.now(), entries: data });
  }

  importBackup(json) {
    try {
      const obj = JSON.parse(json);
      if (!obj.entries) throw new Error('invalid backup');
      for (const e of obj.entries) {
        this.map.delete(e.k);
        const entry = new CacheEntry(e.k, e.v, e.expireAt - Date.now());
        entry.expireAt = e.expireAt;
        this.map.set(e.k, entry);
      }
      return obj.entries.length;
    } catch (e) {
      logger.warn('缓存导入失败', { error: e.message });
      return 0;
    }
  }
}

module.exports = new LruTtlCache();
