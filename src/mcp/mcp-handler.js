// mcp-handler.js - MCP-GUI 处理器（可嵌入主服务）
// 实现 Model Context Protocol (MCP) 的 Streamable HTTP transport，封装 PyAutoGUI 提供 GUI 工具：
//   mouse_move / mouse_click / keyboard_type / take_screenshot / screen_size / keyboard_hotkey
// 可被主服务直接挂载到 /mcp 路由（同进程同端口），也可被独立服务器复用。
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'oyuan-mcp-gui', version: '1.0.0' };

const BRIDGE = path.join(__dirname, '..', '..', 'src', 'tools', 'gui_bridge.py');

function pythonCmd() {
  const isWin = os.platform() === 'win32';
  return isWin ? 'python' : (fs.existsSync('/usr/bin/python3') ? 'python3' : 'python');
}

// ---- 工具定义（JSON Schema） ----
const TOOLS = [
  {
    name: 'mouse_move',
    description: '移动鼠标指针到指定坐标 (x, y)。坐标是屏幕像素坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 X 坐标' },
        y: { type: 'number', description: '目标 Y 坐标' },
        duration: { type: 'number', description: '移动持续时间（秒），默认 0.2' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'mouse_click',
    description: '在指定坐标（或当前指针位置）点击鼠标。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '可选：点击的 X 坐标（不填则点击当前位置）' },
        y: { type: 'number', description: '可选：点击的 Y 坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键，默认 left' },
        clicks: { type: 'integer', description: '点击次数，默认 1' }
      }
    }
  },
  {
    name: 'keyboard_type',
    description: '输入文本（支持中文 Unicode）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        interval: { type: 'number', description: '字符间隔秒，默认 0.02' }
      },
      required: ['text']
    }
  },
  {
    name: 'take_screenshot',
    description: '截取当前屏幕，返回 PNG 图像（base64）。',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'array', items: { type: 'number' }, description: '可选：[x, y, w, h] 截取区域' }
      }
    }
  },
  {
    name: 'screen_size',
    description: '获取屏幕分辨率（宽 x 高）。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'keyboard_hotkey',
    description: '发送组合键，如 ctrl+c / alt+tab。',
    inputSchema: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: '组合键，+ 分隔，如 ctrl+c' }
      },
      required: ['combo']
    }
  }
];

// ---- 调用 gui_bridge.py ----
function runBridge(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const py = pythonCmd();
    const spawnArgs = [BRIDGE, cmd];
    if (args) spawnArgs.push(JSON.stringify(args));
    const proc = spawn(py, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} reject(new Error('GUI 桥接超时')); }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) { reject(new Error('缺少 pyautogui/Pillow: ' + stderr.trim())); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('桥接返回异常: ' + (stderr.trim() || stdout.slice(0, 200)))); }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error('无法启动 Python: ' + err.message)); });
  });
}

// ---- 工具执行 ----
async function executeTool(name, args) {
  try {
    switch (name) {
      case 'mouse_move':
        await runBridge('mouse', { action: 'move', x: args.x, y: args.y, duration: args.duration || 0.2 });
        return { content: [{ type: 'text', text: 'ok: 指针移动到 (' + args.x + ',' + args.y + ')' }] };
      case 'mouse_click':
        await runBridge('mouse', { action: 'click', x: args.x, y: args.y, button: args.button || 'left', clicks: args.clicks || 1 });
        return { content: [{ type: 'text', text: 'ok: 点击完成 (' + (args.x != null ? args.x + ',' + args.y : '当前位置') + ')' }] };
      case 'keyboard_type':
        await runBridge('keyboard', { action: 'write', text: String(args.text || ''), interval: args.interval || 0.02 });
        return { content: [{ type: 'text', text: 'ok: 已输入文本' }] };
      case 'take_screenshot': {
        const res = args.region
          ? await runBridge('screencrop', { region: args.region })
          : await runBridge('screenshot');
        if (!res.ok || !res.png_base64) throw new Error('截图失败');
        return {
          content: [
            { type: 'text', text: '屏幕截图 ' + res.width + 'x' + res.height },
            { type: 'image', data: res.png_base64, mimeType: 'image/png' }
          ]
        };
      }
      case 'screen_size': {
        const s = await runBridge('screen');
        return { content: [{ type: 'text', text: s.width + 'x' + s.height }] };
      }
      case 'keyboard_hotkey':
        await runBridge('keyboard', { action: 'hotkey', combo: String(args.combo || '') });
        return { content: [{ type: 'text', text: 'ok: 组合键 ' + args.combo + ' 已发送' }] };
      default:
        return { content: [{ type: 'text', text: '未知工具: ' + name }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: '执行失败: ' + e.message }], isError: true };
  }
}

// ---- MCP 处理（挂载到任意 http 路由） ----
// 用法: mcpHandler(req, res) —— req 需有 method/url/headers/on('data')/on('end')
async function mcpHandler(req, res, opts = {}) {
  const token = opts.token || process.env.MCP_GUI_TOKEN || '';
  const authorized = !token || (req.headers['authorization'] || '') === 'Bearer ' + token;
  if (!authorized) {
    sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } });
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } });
      return;
    }
    const method = msg.method;
    if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (method === 'initialize') {
      return sendJson(res, 200, {
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }
      });
    }
    if (method === 'tools/list') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = (msg.params || {});
      const result = await executeTool(name, args || {});
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    }
    return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + method } });
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function healthInfo() {
  return { ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version, tools: TOOLS.length, embedded: true };
}

module.exports = { mcpHandler, executeTool, healthInfo, SERVER_INFO, TOOLS };
