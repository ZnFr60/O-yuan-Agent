// gui-automation.js - 虚拟鼠标/键盘/截屏工具（严格服从三级权限）
// GUI 操作属于系统级动作，仅"完全访问(full)"权限允许；中等/无权限禁止并拒绝。
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const config = require('../core/config');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

// 检测可用的 python 命令（Windows 用 python，Unix 用 python3，兼容不同安装）
function pythonCmd() {
  const isWin = os.platform() === 'win32';
  return isWin ? 'python' : (fs.existsSync('/usr/bin/python3') ? 'python3' : 'python');
}

const BRIDGE = path.join(__dirname, '..', '..', '..', 'src', 'tools', 'gui_bridge.py');

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
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (e) {
        reject(new Error('GUi 桥接返回异常 (code=' + code + '): ' + (stderr.trim() || stdout.slice(0, 200))));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error('无法启动 Python: ' + err.message)); });
  });
}

class GuiAutomation {
  // 权限守卫：仅完全访问
  requireFull() {
    if (!permissions.can('guiControl')) {
      throw new Error('GUI 自动化为系统级高危操作，仅"完全访问(full)"权限允许。当前权限=' + permissions.effective);
    }
  }

  async screen() {
    this.requireFull();
    return runBridge('screen');
  }

  async screenshot() {
    this.requireFull();
    const res = await runBridge('screenshot');
    if (res.ok && res.png_base64) {
      return { ok: true, width: res.width, height: res.height, png_base64: res.png_base64 };
    }
    return res;
  }

  async screencrop(region) {
    this.requireFull();
    return runBridge('screencrop', { region });
  }

  async mouse(action, args) {
    this.requireFull();
    return runBridge('mouse', { action, ...args });
  }

  async keyboard(action, args) {
    this.requireFull();
    return runBridge('keyboard', { action, ...args });
  }

  async isAvailable() {
    try {
      const r = await runBridge('screen', null, 5000);
      return !!r.width;
    } catch (e) {
      return false;
    }
  }

  // 保存截图到日志目录（便于前端/调试查看），返回文件路径
  async screenshotToFile(dir) {
    this.requireFull();
    const res = await runBridge('screenshot');
    if (!res.ok || !res.png_base64) throw new Error('截屏失败');
    const buf = Buffer.from(res.png_base64, 'base64');
    const file = path.join(dir, 'screen-' + Date.now() + '.png');
    fs.writeFileSync(file, buf);
    logger.info('已保存屏幕截图', { file, size: buf.length });
    return file;
  }
}

module.exports = new GuiAutomation();
