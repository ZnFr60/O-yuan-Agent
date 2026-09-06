#!/usr/bin/env node
// O-yuan (启原) 全局命令入口
// 用法:
//   oyuan start [--port 3088]   启动服务
//   oyuan status                查看服务状态
//   oyuan config                查看配置路径
//   oyuan --version             查看版本
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const cmd = args[0] || 'start';

// 项目根目录（NPM 全局安装时在 ../ 相对位置）
const rootDir = path.resolve(__dirname, '..');
const serverFile = path.join(rootDir, 'src', 'js', 'server.js');
const pkgPath = path.join(rootDir, 'package.json');

function getVersion() {
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; }
  catch (e) { return 'unknown'; }
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log('O-yuan v' + getVersion());
  process.exit(0);
}

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`
O-yuan (启原) v${getVersion()} - 跨平台通用智能体 Agent

用法:
  oyuan start [--port 3088]   启动服务（默认）
  oyuan status                 查看服务状态
  oyuan config                 查看配置文件路径
  oyuan --version              查看版本
  oyuan --help                 显示帮助

访问地址: http://127.0.0.1:3088
`);
  process.exit(0);
}

if (cmd === 'config') {
  const cfgPath = path.join(rootDir, 'config', 'config.json');
  console.log('配置文件路径: ' + cfgPath);
  console.log('存在: ' + (fs.existsSync(cfgPath) ? '是' : '否（首次启动自动生成）'));
  process.exit(0);
}

if (cmd === 'status') {
  const http = require('http');
  http.get('http://127.0.0.1:3088/api/status', (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      try {
        const s = JSON.parse(data);
        console.log('✅ O-yuan 服务运行中');
        console.log('   版本: v' + s.version);
        console.log('   权限: ' + s.permissions.effective);
        console.log('   原生加速: ' + (s.native ? '已启用' : 'JS 降级'));
        console.log('   访问: http://127.0.0.1:3088');
      } catch (e) {
        console.log('服务响应异常');
      }
      process.exit(0);
    });
  }).on('error', () => {
    console.log('❌ O-yuan 服务未运行');
    console.log('   启动命令: oyuan start');
    process.exit(1);
  });
  return;
}

// start（默认）
if (cmd === 'start' || !cmd) {
  // 解析 --port 参数
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? args[portIdx + 1] : null;

  if (!fs.existsSync(serverFile)) {
    console.error('❌ 找不到服务入口: ' + serverFile);
    process.exit(1);
  }

  console.log('🚀 启动 O-yuan v' + getVersion() + ' ...');
  console.log('   项目目录: ' + rootDir);
  console.log('   访问地址: http://127.0.0.1:' + (port || 3088));
  console.log('   按 Ctrl+C 停止\n');

  const child = spawn('node', [serverFile, ...(port ? ['--port', port] : [])], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env }
  });

  child.on('error', (err) => {
    console.error('启动失败: ' + err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n正在停止 O-yuan ...');
    child.kill('SIGTERM');
    process.exit(0);
  });
}
