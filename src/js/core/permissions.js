// permissions.js - 三级系统执行权限控制（O-yuan 启原）
// none(无权限) / medium(中等权限) / full(完全访问)
// 开发者导向：仅权限等级控制，无系统路径保护、无沙箱。
'use strict';
const config = require('./config');
const logger = require('./logger');

const LEVELS = { none: 0, medium: 1, full: 2 };

// 各权限对应的能力矩阵：
//   none   - 仅工作区内操作；可执行不涉及系统底层的安全命令
//   medium - 可访问所有目录；可运行高级 Shell；可增删文件
//   full   - 最高级别：任意命令、任意文件读写、修改系统配置
const CAPABILITIES = {
  none: {
    llmChat: true,
    fileRead: false,
    workspaceRead: true,
    fileWrite: false,
    workspaceWrite: true,
    execCommand: false,
    execSafeCommand: true,
    execAdvancedShell: false,
    readSysInfo: false,
    modifyConfig: false,
    guiControl: false
  },
  medium: {
    llmChat: true,
    fileRead: true,
    workspaceRead: true,
    fileWrite: true,
    workspaceWrite: true,
    execCommand: false,
    execSafeCommand: true,
    execAdvancedShell: true,
    readSysInfo: true,
    modifyConfig: false,
    guiControl: false
  },
  full: {
    llmChat: true,
    fileRead: true,
    workspaceRead: true,
    fileWrite: true,
    workspaceWrite: true,
    execCommand: true,
    execSafeCommand: true,
    execAdvancedShell: true,
    readSysInfo: true,
    modifyConfig: true,
    guiControl: true
  }
};

class PermissionManager {
  constructor() {
    this.effective = 'medium';
  }

  // 计算生效权限档位。Agent 控制权限与访问来源无关：始终等于配置的权限。
  computeEffective({ lanEnabled, hasPassword }) {
    const level = config.get(['permissions', 'global']) || 'medium';
    this.effective = level;
    return { effective: level, configured: level };
  }

  getLevel() { return this.effective; }

  can(permission) {
    const caps = CAPABILITIES[this.effective] || CAPABILITIES.none;
    return !!caps[permission];
  }

  // 文件写入检查：开发者导向，无系统路径保护，仅看权限等级
  canWritePath(targetPath) {
    return this.can('fileWrite');
  }

  require(permission, targetPath) {
    if (!this.can(permission)) {
      throw new Error('权限不足：当前权限档位 [' + this.effective + '] 不允许操作 [' + permission + ']');
    }
    return true;
  }

  capabilities() {
    return CAPABILITIES[this.effective];
  }

  // 平台感知的 shell 名称
  shellName() {
    return process.platform === 'win32' ? 'PowerShell' : 'Shell (bash/zsh)';
  }

  describe() {
    const shell = this.shellName();
    const map = {
      none: '仅工作区内操作 + 安全命令（不涉及系统底层）',
      medium: '访问所有目录 + ' + shell + ' + 增删文件',
      full: '完全访问：任意命令 / 任意文件 / 系统配置'
    };
    return map[this.effective] || this.effective;
  }
}

module.exports = new PermissionManager();
