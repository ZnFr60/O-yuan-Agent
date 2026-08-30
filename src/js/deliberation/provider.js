// provider.js - LLM API 客户端（多服务商接入，OpenAI 兼容协议 + 容错黑名单）
'use strict';
const https = require('https');
const http = require('http');
const config = require('../core/config');
const logger = require('../core/logger');

class ProviderClient {
  // 调用单个模型。opts: {model, apiKey, baseUrl, temperature, topP, maxTokens, timeoutMs, tools}
  // tools: 原生 function calling 工具定义数组（OpenAI/DeepSeek 兼容），响应含 tool_calls
  async call(modelCfg, messages, opts = {}) {
    const baseUrl = modelCfg.baseUrl || 'https://api.openai.com/v1';
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: modelCfg.model || modelCfg.id,
      messages,
      temperature: opts.temperature,
      top_p: opts.topP,
      max_tokens: opts.maxTokens || 2048,
      stream: false
    };
    if (opts.tools && Array.isArray(opts.tools)) body.tools = opts.tools;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (modelCfg.apiKey || '')
    };
    const timeout = opts.timeoutMs || modelCfg.timeoutMs || 60000;
    return new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers, timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) { /* fallthrough */ }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const msg0 = parsed && parsed.choices && parsed.choices[0]
              ? parsed.choices[0].message : null;
            const content = msg0 ? (msg0.content || '') : data;
            // 原生 function calling：解析 tool_calls
            const toolCalls = (msg0 && msg0.tool_calls) || [];
            resolve({
              content: String(content),
              reasoning: msg0 && msg0.reasoning_content ? String(msg0.reasoning_content) : undefined,
              toolCalls: toolCalls.map(tc => ({
                id: tc.id,
                name: tc.function && tc.function.name,
                arguments: tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
              })),
              raw: parsed,
              usage: parsed && parsed.usage,
              model: parsed && parsed.model,
              status: res.statusCode
            });
          } else {
            const errMsg = parsed && parsed.error && parsed.error.message
              ? parsed.error.message : 'HTTP ' + res.statusCode;
            const err = new Error(errMsg);
            err.statusCode = res.statusCode;
            err.model = modelCfg.id;
            reject(err);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 获取服务商可用模型列表：GET {baseUrl}/models（OpenAI 兼容）
  async listModels(modelCfg) {
    const baseUrl = modelCfg.baseUrl || 'https://api.openai.com/v1';
    const endpoint = baseUrl.replace(/\/+$/, '') + '/models';
    const headers = {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + (modelCfg.apiKey || '')
    };
    const timeout = 15000;
    return new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'GET', headers, timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) {}
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const items = (parsed && parsed.data) || [];
            const models = items
              .map((m) => m.id)
              .filter(Boolean)
              .sort();
            resolve({ ok: true, models, count: models.length });
          } else {
            const errMsg = parsed && parsed.error && parsed.error.message
              ? parsed.error.message : 'HTTP ' + res.statusCode;
            resolve({ ok: false, error: errMsg, status: res.statusCode });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时（15s）' }); });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end();
    });
  }

  // 连接验证：用最小请求测试 API 是否连通（不消耗多少 token）
  async testConnection(modelCfg) {
    const baseUrl = modelCfg.baseUrl || 'https://api.openai.com/v1';
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: modelCfg.model || modelCfg.id,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    };
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (modelCfg.apiKey || '')
    };
    const timeout = 15000;
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers, timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) {}
          const latency = Date.now() - start;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, latency, model: (parsed && parsed.model) || body.model, note: '连接成功' });
          } else {
            const errMsg = parsed && parsed.error && parsed.error.message
              ? parsed.error.message : 'HTTP ' + res.statusCode;
            resolve({ ok: false, latency, error: errMsg, status: res.statusCode });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时（15s）', latency: Date.now() - start }); });
      req.on('error', (e) => resolve({ ok: false, error: e.message, latency: Date.now() - start }));
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 流式调用：opts.onToken(delta), opts.onDone(fullResult), opts.onError(err)
  async stream(modelCfg, messages, opts = {}) {
    const baseUrl = modelCfg.baseUrl || 'https://api.openai.com/v1';
    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: modelCfg.model || modelCfg.id,
      messages,
      temperature: opts.temperature,
      top_p: opts.topP,
      max_tokens: opts.maxTokens || 2048,
      stream: true
    };
    if (opts.tools && Array.isArray(opts.tools)) body.tools = opts.tools;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (modelCfg.apiKey || '')
    };
    const timeout = opts.timeoutMs || modelCfg.timeoutMs || 60000;
    const onToken = opts.onToken || (() => {});
    const onDone = opts.onDone || (() => {});
    const onError = opts.onError || ((e) => { throw e; });
    return new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers, timeout }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errData = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (errData += c));
          res.on('end', () => {
            let msg = 'HTTP ' + res.statusCode;
            try { const p = JSON.parse(errData); if (p.error && p.error.message) msg = p.error.message; } catch (e) {}
            const err = new Error(msg); err.statusCode = res.statusCode; reject(err);
          });
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        let full = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留不完整的最后一行
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              if (delta && delta.content) {
                full += delta.content;
                onToken(delta.content);
              }
            } catch (e) { /* 忽略无法解析的行 */ }
          }
        });
        res.on('end', () => {
          resolve({ content: full, model: body.model, streamed: true });
          onDone({ content: full, model: body.model, streamed: true });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = new ProviderClient();
