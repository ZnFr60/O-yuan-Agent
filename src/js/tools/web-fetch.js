// web-fetch.js - 网页获取工具
// 获取网页内容，支持 HTML 转纯文本、JSON API 调用。
// 参考 DSH web + web-fetch-http 设计。
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

const DEFAULT_TIMEOUT = 15000;
const MAX_CONTENT = 100000; // 最大内容长度

// 简单的 HTML 转纯文本（去除标签，保留结构）
function htmlToText(html) {
  if (!html) return '';
  let text = html;
  // 移除 script 和 style 内容
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // 块级元素换行
  text = text.replace(/<(br|p|div|h[1-6]|li|tr|article|section|header|footer|nav|main|aside)[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|nav|main|aside)>/gi, '\n');
  // 移除所有标签
  text = text.replace(/<[^>]+>/g, '');
  // 解码 HTML 实体
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  // 清理多余空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  return text.trim();
}

// HTTP 请求
function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效 URL: ' + urlStr)); }
    const lib = u.protocol === 'https:' ? https : http;
    const timeout = opts.timeoutMs || DEFAULT_TIMEOUT;
    const method = opts.method || 'GET';
    const headers = {
      'User-Agent': 'O-yuan-Agent/3.0',
      'Accept': opts.raw ? '*/*' : 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      ...(opts.headers || {})
    };
    if (opts.body) headers['Content-Type'] = opts.contentType || 'application/json';

    const req = lib.request(u, { method, headers, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > MAX_CONTENT * 2) {
          // 超大内容：截断连接
          req.destroy();
        }
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data.slice(0, MAX_CONTENT),
          truncated: data.length > MAX_CONTENT,
          url: urlStr
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时(' + (timeout / 1000) + 's)')); });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

// 获取网页并转纯文本
async function fetch(urlStr, opts = {}) {
  permissions.require('fileRead');
  logger.info('web_fetch', { url: urlStr, raw: opts.raw });
  try {
    const res = await request(urlStr, opts);
    const contentType = (res.headers['content-type'] || '').toLowerCase();
    let content = res.body;
    let isJson = false;
    let isHtml = false;

    if (contentType.includes('json') || (content.startsWith('{') || content.startsWith('['))) {
      isJson = true;
      try {
        const parsed = JSON.parse(content);
        content = JSON.stringify(parsed, null, 2);
      } catch (e) { /* 保持原样 */ }
    } else if (contentType.includes('html') && !opts.raw) {
      isHtml = true;
      content = htmlToText(content);
    }

    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      url: urlStr,
      statusCode: res.statusCode,
      contentType,
      isJson,
      isHtml,
      content: content.slice(0, MAX_CONTENT),
      contentLength: content.length,
      truncated: res.truncated || content.length >= MAX_CONTENT,
      finalUrl: res.headers.location || urlStr
    };
  } catch (e) {
    return { ok: false, url: urlStr, error: e.message };
  }
}

module.exports = { fetch, request, htmlToText };
