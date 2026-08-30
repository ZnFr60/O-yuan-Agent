// filesystem.js - 文件系统工具集
// 参考 Claude Code str_replace_editor + DSH fs 工具设计：
//   read_file / write_file / edit_file / search_files / list_dir / glob
// 开发者导向：无沙箱、无路径保护，仅靠权限等级控制。
'use strict';
const fs = require('fs');
const path = require('path');
const permissions = require('../core/permissions');
const logger = require('../core/logger');

const MAX_READ_BYTES = 200 * 1024; // 单次读取最大 200KB
const MAX_SEARCH_RESULTS = 100;
const MAX_LIST_ENTRIES = 500;

// 解析路径：支持相对路径（基于工作目录）和绝对路径
function resolvePath(p) {
  if (!p) return process.cwd();
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

// 安全的文件读取：大文件分块、支持行范围
function readFile(filePath, opts = {}) {
  permissions.require('fileRead', filePath);
  const abs = resolvePath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在: ' + filePath };
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return { ok: false, error: '路径是目录，不是文件: ' + filePath };

  const { offset = 0, limit = 0 } = opts;
  let content;
  if (stat.size > MAX_READ_BYTES && !offset && !limit) {
    // 大文件：只读前 MAX_READ_BYTES
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    fs.closeSync(fd);
    content = buf.toString('utf8', 0, read);
    return {
      ok: true,
      path: abs,
      size: stat.size,
      truncated: true,
      readBytes: read,
      content,
      note: '文件过大(' + stat.size + '字节)，仅读取前 ' + read + ' 字节。使用 offset/limit 分块读取。'
    };
  }

  let data = fs.readFileSync(abs, 'utf8');
  // 行范围筛选
  if (offset > 0 || limit > 0) {
    const lines = data.split('\n');
    const start = Math.max(0, offset - 1);
    const end = limit > 0 ? Math.min(lines.length, start + limit) : lines.length;
    const selected = lines.slice(start, end);
    // 带行号
    const numbered = selected.map((line, i) => String(start + i + 1).padStart(6, ' ') + ' | ' + line);
    return {
      ok: true,
      path: abs,
      size: stat.size,
      totalLines: lines.length,
      startLine: start + 1,
      endLine: end,
      content: numbered.join('\n')
    };
  }
  return { ok: true, path: abs, size: stat.size, content: data };
}

// 写入文件：覆盖或新建
function writeFile(filePath, content, opts = {}) {
  permissions.require('fileWrite', filePath);
  const abs = resolvePath(filePath);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, String(content != null ? content : ''), 'utf8');
  logger.info('写入文件', { path: abs, bytes: Buffer.byteLength(String(content || '')), existed });
  return { ok: true, path: abs, bytesWritten: Buffer.byteLength(String(content || '')), created: !existed, overwritten: existed };
}

// 精确字符串替换编辑（类似 Claude Code str_replace_editor）
// old_string 必须在文件中唯一匹配，否则报错
function editFile(filePath, oldString, newString) {
  permissions.require('fileWrite', filePath);
  const abs = resolvePath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在: ' + filePath };
  if (fs.statSync(abs).isDirectory()) return { ok: false, error: '路径是目录: ' + filePath };

  const content = fs.readFileSync(abs, 'utf8');
  if (!oldString) return { ok: false, error: 'old_string 不能为空' };

  // 统计匹配次数
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(oldString, idx)) !== -1) { count++; idx += oldString.length; }

  if (count === 0) return { ok: false, error: '未找到匹配的 old_string。请确保字符串与文件内容完全一致（包括空格和缩进）。' };
  if (count > 1) return { ok: false, error: 'old_string 不唯一，匹配到 ' + count + ' 处。请提供更长的上下文使匹配唯一。' };

  const newContent = content.replace(oldString, newString);
  fs.writeFileSync(abs, newContent, 'utf8');
  logger.info('编辑文件', { path: abs, oldLen: oldString.length, newLen: newString.length });
  return {
    ok: true,
    path: abs,
    replacements: 1,
    oldLength: oldString.length,
    newLength: newString.length,
    note: '已完成 1 处替换'
  };
}

// 在目录中搜索内容（grep）
function searchFiles(pattern, searchPath, opts = {}) {
  permissions.require('fileRead');
  const abs = resolvePath(searchPath || '.');
  if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在: ' + searchPath };

  const { include = null, exclude = null, maxResults = MAX_SEARCH_RESULTS, caseSensitive = false } = opts;
  const results = [];
  const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');

  function shouldSkip(name) {
    if (exclude) {
      const excl = Array.isArray(exclude) ? exclude : [exclude];
      if (excl.some(pat => name.includes(pat))) return true;
    }
    // 默认跳过常见无关目录
    if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.pnpm-store'].some(d => name === d || name.includes('/' + d + '/'))) return true;
    return false;
  }

  function searchDir(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (shouldSkip(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        searchDir(full);
      } else if (entry.isFile()) {
        if (include) {
          const inc = Array.isArray(include) ? include : [include];
          if (!inc.some(pat => entry.name.endsWith(pat) || entry.name.includes(pat))) continue;
        }
        // 跳过二进制和大文件
        try {
          const stat = fs.statSync(full);
          if (stat.size > 2 * 1024 * 1024) continue; // 跳过 >2MB 文件
          const content = fs.readFileSync(full, 'utf8');
          regex.lastIndex = 0;
          let match;
          let lineNum = 0;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push({
                file: full,
                line: i + 1,
                content: lines[i].trim().slice(0, 200)
              });
            }
          }
        } catch (e) { /* 跳过无法读取的文件 */ }
      }
    }
  }

  if (fs.statSync(abs).isFile()) {
    // 单文件搜索
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push({ file: abs, line: i + 1, content: lines[i].trim().slice(0, 200) });
        }
      }
    } catch (e) { return { ok: false, error: e.message }; }
  } else {
    searchDir(abs);
  }

  return { ok: true, pattern, path: abs, count: results.length, truncated: results.length >= maxResults, results };
}

// 列出目录内容
function listDir(dirPath, opts = {}) {
  permissions.require('fileRead');
  const abs = resolvePath(dirPath || '.');
  if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在: ' + dirPath };
  if (!fs.statSync(abs).isDirectory()) return { ok: false, error: '不是目录: ' + dirPath };

  const { maxEntries = MAX_LIST_ENTRIES, showHidden = false } = opts;
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.message }; }

  const items = [];
  for (const entry of entries) {
    if (items.length >= maxEntries) break;
    if (!showHidden && entry.name.startsWith('.')) continue;
    const full = path.join(abs, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    items.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
      size: stat.size,
      modified: stat.mtime.toISOString()
    });
  }
  // 目录在前，文件在后，按名称排序
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: abs, count: items.length, total: entries.length, truncated: items.length >= maxEntries, entries: items };
}

// glob 模式匹配文件
function globFiles(pattern, searchPath) {
  permissions.require('fileRead');
  const abs = resolvePath(searchPath || '.');
  if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在: ' + searchPath };

  // 简化的 glob：支持 * 和 ** 模式
  const results = [];
  const maxResults = 500;

  // 将 glob 模式转为正则
  function globToRegex(glob) {
    let regex = '';
    let i = 0;
    while (i < glob.length) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          // ** 匹配任意路径
          regex += '.*';
          i += 2;
          if (glob[i] === '/') i++;
        } else {
          // * 匹配单级路径
          regex += '[^/]*';
          i++;
        }
      } else if (c === '?') {
        regex += '[^/]';
        i++;
      } else if ('.+^$(){}|\\'.includes(c)) {
        regex += '\\' + c;
        i++;
      } else {
        regex += c;
        i++;
      }
    }
    return new RegExp('^' + regex + '$');
  }

  const regex = globToRegex(pattern);

  function walk(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(abs, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (regex.test(rel)) results.push(full);
      }
    }
  }

  walk(abs);
  return { ok: true, pattern, path: abs, count: results.length, truncated: results.length >= maxResults, files: results };
}

module.exports = {
  readFile,
  writeFile,
  editFile,
  searchFiles,
  listDir,
  globFiles
};
