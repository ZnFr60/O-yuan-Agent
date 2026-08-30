// mcp-gui-server.js - MCP-GUI 服务器（可选独立启动；默认已嵌入主服务 /mcp 路由）
// 复用 src/mcp/mcp-handler.js。如需独立进程给外部 MCP 客户端接入：
//   node src/mcp/mcp-gui-server.js [port]
'use strict';
const http = require('http');
const { mcpHandler, healthInfo } = require('./mcp-handler');

const PORT = parseInt(process.argv[2] || process.env.MCP_GUI_PORT || '3090', 10);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
    mcpHandler(req, res);
  } else if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify(healthInfo());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } else {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'not found' } });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[MCP-GUI] oyuan-mcp-gui 监听 http://127.0.0.1:' + PORT + '/mcp（也可通过主服务 /mcp 嵌入访问）');
});
server.on('error', (e) => { console.error('[MCP-GUI] 启动失败: ' + e.message); process.exit(1); });
