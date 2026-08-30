// mcp-client.js - MCP 客户端（GUI Agent 通过它调用 MCP-GUI 服务器的工具）
'use strict';
const http = require('http');
const config = require('../core/config');
const logger = require('../core/logger');

const DEFAULT_URL = 'http://127.0.0.1:3088/mcp'; // 默认走嵌入式路由（同主服务端口）

class McpClient {
  constructor() {
    this.url = null;
    this.token = '';
    this.serverInfo = null;
  }

  init() {
    if (!config.data) config.load();
    const c = config.get(['mcpGui']) || {};
    this.url = c.url || DEFAULT_URL;
    this.token = c.token || '';
  }

  // 发送 JSON-RPC 请求
  _call(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      const req = http.request(u, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message || 'MCP error'));
            else resolve(parsed.result);
          } catch (e) { reject(new Error('MCP 响应异常: ' + data.slice(0, 200))); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('MCP 请求超时')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // 握手
  async initialize() {
    const r = await this._call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'oyuan-agent', version: '1.0.0' } }, 5000);
    this.serverInfo = r.serverInfo;
    return r;
  }

  async listTools() {
    const r = await this._call('tools/list', {});
    return (r.tools || []).map(t => t.name);
  }

  async callTool(name, args = {}) {
    const r = await this._call('tools/call', { name, arguments: args });
    return r;
  }

  // 便捷封装
  async mouseMove(x, y) { return this.callTool('mouse_move', { x, y }); }
  async mouseClick(x, y, button = 'left') { return this.callTool('mouse_click', { x, y, button }); }
  async keyboardType(text) { return this.callTool('keyboard_type', { text }); }
  async screenshot() { return this.callTool('take_screenshot', {}); }
  async screenSize() { return this.callTool('screen_size', {}); }

  // 健康检查
  async ping() {
    try {
      await this.initialize();
      const tools = await this.listTools();
      return { ok: true, tools };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = new McpClient();
