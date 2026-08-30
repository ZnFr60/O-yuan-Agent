// search.js - 联网搜索工具（严格服从三级权限管控）
'use strict';
const https = require('https');
const http = require('http');
const config = require('../core/config');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

// DuckDuckGo 简化 HTML 搜索接口（无 key，仅供测试/内网环境示例）
function duckduckgo(query, max) {
  return new Promise((resolve, reject) => {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 ConclaveAgent/0.1' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const results = [];
          const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          const reS = /class="result__snippet"[^>]*>([\s\S]*?)<\//g;
          const links = [];
          const snippets = [];
          let m;
          while ((m = re.exec(data)) && links.length < max) {
            links.push({ href: m[1], title: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') });
          }
          while ((m = reS.exec(data)) && snippets.length < max) snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
          for (let i = 0; i < links.length; ++i) {
            results.push({ title: links[i].title, url: links[i].href, snippet: snippets[i] || '' });
          }
          resolve(results);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class SearchTool {
  async search(query, opts = {}) {
    // 权限管控：搜索是外部动作，至少需要 medium 权限
    if (!permissions.can('execCommand') && !permissions.can('readSysInfo')) {
      throw new Error('当前权限不允许联网搜索');
    }
    const cfg = config.get(['search']) || {};
    if (cfg.enabled === false && opts.force !== true) {
      throw new Error('联网搜索已关闭');
    }
    const max = opts.max || cfg.maxResults || 5;
    const provider = opts.provider || cfg.provider || 'duckduckgo';
    logger.info('执行联网搜索', { provider, query: query.slice(0, 80) });
    if (provider === 'duckduckgo') return duckduckgo(query, max);
    throw new Error('不支持的搜索提供商: ' + provider);
  }
}

module.exports = new SearchTool();
