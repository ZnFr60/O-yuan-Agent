// native.js - C++ 原生扩展加载器（带纯 JS 降级实现）
// 优先加载 build/Release/conclave_native.node；
// 若编译产物缺失或平台不兼容，自动回退到同名的 JS 实现，保证应用始终可运行。
'use strict';
const path = require('path');

let nativeImpl = null;
let fallbackImpl = null;

function loadNative() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'build', 'Release', 'conclave_native.node'),
    path.join(__dirname, '..', '..', '..', 'build', 'Debug', 'conclave_native.node')
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod && typeof mod.normalizedHash === 'function') {
        return { impl: mod, native: true };
      }
    } catch (e) { /* try next */ }
  }
  return { impl: null, native: false };
}

// ---------- 纯 JS 降级实现 ----------
function normalizeTextJS(input, lower = true) {
  if (typeof input !== 'string') return '';
  let out = input.replace(/[\t\n\r\f\v]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (lower) out = out.toLowerCase();
  return out;
}

// FNV-1a 64 位（与 C++ 实现一致）
function stableHash64(str) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const buf = Buffer.from(str, 'utf8');
  for (const byte of buf) { hash ^= BigInt(byte); hash = (hash * prime) & 0xFFFFFFFFFFFFFFFFn; }
  return hash.toString(16).padStart(16, '0');
}

function normalizedHashJS(input) {
  return stableHash64(normalizeTextJS(input, true));
}

function unigramsJS(s) {
  // 提取 Unicode 字符（简化，按 code point）
  const out = [];
  for (const ch of s) out.push(ch);
  return out;
}

function cosineSimilarityJS(a, b) {
  const ua = unigramsJS(a), ub = unigramsJS(b);
  if (!ua.length || !ub.length) return 0;
  const fa = {}, fb = {};
  for (const t of ua) fa[t] = (fa[t] || 0) + 1;
  for (const t of ub) fb[t] = (fb[t] || 0) + 1;
  let dot = 0, na = 0, nb = 0;
  for (const k in fa) { dot += (fa[k] || 0) * (fb[k] || 0); na += fa[k] * fa[k]; }
  for (const k in fb) nb += fb[k] * fb[k];
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ngramsJS(s, n) {
  const u = unigramsJS(s);
  const out = [];
  if (u.length < n) return u.length ? [s] : [];
  for (let i = 0; i + n <= u.length; ++i) out.push(u.slice(i, i + n).join(''));
  return out;
}

function jaccardSimilarityJS(a, b) {
  const ga = new Set(ngramsJS(a, 2)), gb = new Set(ngramsJS(b, 2));
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const uni = ga.size + gb.size - inter;
  if (!uni) return 1;
  return inter / uni;
}

function levenshteinDistanceJS(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; ++j) dp[0][j] = j;
  for (let i = 1; i <= m; ++i)
    for (let j = 1; j <= n; ++j) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  return dp[m][n];
}

function chunkTextJS(text, chunkSize = 1000, overlap = 100) {
  const chunks = [];
  if (!text) return chunks;
  if (overlap >= chunkSize) overlap = Math.floor(chunkSize / 2);
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + chunkSize, text.length);
    chunks.push(text.slice(pos, end));
    if (end === text.length) break;
    const next = end > overlap ? end - overlap : end;
    pos = next > pos ? next : pos + 1;
  }
  return chunks;
}

function keywordWeightsJS(text) {
  const toks = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]/g) || [];
  const freq = {};
  for (const t of toks) freq[t] = (freq[t] || 0) + 1;
  const total = toks.length || 1;
  return Object.entries(freq).map(([token, count]) => ({ token, weight: count / total }))
    .sort((x, y) => y.weight - x.weight);
}

function renderRoleTemplateJS(tmpl, vars = {}) {
  let out = tmpl;
  for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
}

// ---------- 导出统一接口 ----------
function init() {
  const res = loadNative();
  nativeImpl = res.impl;
  if (res.native) return res;

  fallbackImpl = {
    normalizeText: normalizeTextJS,
    normalizedHash: normalizedHashJS,
    cosineSimilarity: cosineSimilarityJS,
    jaccardSimilarity: jaccardSimilarityJS,
    levenshteinDistance: levenshteinDistanceJS,
    chunkText: chunkTextJS,
    keywordWeights: keywordWeightsJS,
    renderRoleTemplate: renderRoleTemplateJS
  };
  return { native: false, fallback: true };
}

module.exports = {
  init,
  isNative() { return !!nativeImpl; },
  get impl() { return nativeImpl || fallbackImpl; },
  api() {
    if (!nativeImpl && !fallbackImpl) init();
    return nativeImpl || fallbackImpl;
  }
};
