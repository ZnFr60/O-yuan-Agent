#!/usr/bin/env node
// start.js - 跨平台启动脚本
// 自动检查原生扩展状态并启动服务；支持 --dev 参数。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = __dirname;
const nativePath = path.join(root, 'build', 'Release', 'conclave_native.node');
const nativeOk = fs.existsSync(nativePath);

console.log('==============================================');
console.log('  Conclave 多模型合议智能体 · 跨平台启动器');
console.log('  Node ' + process.version + ' | ' + process.platform + ' ' + process.arch);
console.log('  原生加速: ' + (nativeOk ? '已编译 (C++)' : '未编译 → 自动降级 JS 实现'));
console.log('  页面地址: http://127.0.0.1:3088 (默认)');
console.log('==============================================');

const args = [path.join('src', 'js', 'server.js')];
if (process.argv.includes('--dev')) args.push('--dev');

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root });
child.on('error', (e) => {
  console.error('启动失败: ' + e.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code || 0));
