// app.js - Conclave 前端交互逻辑
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  token: localStorage.getItem('conclave_token') || '',
  theme: localStorage.getItem('conclave_theme') || 'dark',
  roleEnabled: true,
  sidebarPos: localStorage.getItem('conclave_sidebar') || 'left',
  sessionId: localStorage.getItem('conclave_session') || ('s-' + Date.now().toString(36)),
  bg: { enabled: false, url: '', opacity: 30, blur: 0 }
};

// ---------- 工具 ----------
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (data.needSetup || data.needLogin || (data.needPassword && !opts._skipAuth)) {
    await handleAuth();
    throw new Error('AUTH_REQUIRED');
  }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---------- 鉴权流程 ----------
async function handleAuth() {
  const st = await api('/api/auth/status', { _skipAuth: true });
  if (!st.lanEnabled) return; // 本机无需密码
  const pass = prompt('局域网访问需要登录密码：');
  if (pass == null) { location.reload(); return; }
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: pass }) });
    const d = await r.json();
    if (d.ok) { state.token = d.token; localStorage.setItem('conclave_token', d.token); }
    else { alert('密码错误'); location.reload(); }
  } catch (e) { location.reload(); }
}

// ---------- 主题 ----------
// 侧边栏位置（左/右）
function applySidebarPos(pos) {
  state.sidebarPos = pos === 'right' ? 'right' : 'left';
  document.body.setAttribute('data-sidebar', state.sidebarPos);
  localStorage.setItem('conclave_sidebar', state.sidebarPos);
  $$('.sb-pos').forEach(b => b.classList.toggle('active', b.dataset.pos === state.sidebarPos));
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  state.theme = theme;
  localStorage.setItem('conclave_theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀';
  const btn = $$('.theme-btn').find(b => b.dataset.theme === theme);
  if (btn) { $$('.theme-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); }
}

// ---------- 背景 ----------
function loadBgPref() {
  try {
    const p = JSON.parse(localStorage.getItem('conclave_bg') || '{}');
    Object.assign(state.bg, p);
  } catch (e) {}
  if (state.bg.enabled && state.bg.url) applyBg();
}
function applyBg() {
  const bgEl = $('#chat-bg');
  const { enabled, url, opacity, blur } = state.bg;
  if (!enabled || !url) { bgEl.style.opacity = 0; bgEl.style.backgroundImage = ''; return; }
  bgEl.style.backgroundImage = 'url(' + url + ')';
  bgEl.style.opacity = (opacity / 100).toFixed(2);
  bgEl.style.filter = 'blur(' + blur + 'px)';
  $('#bg-opacity').value = opacity; $('#bg-opacity-val').textContent = opacity;
  $('#bg-blur').value = blur; $('#bg-blur-val').textContent = blur;
}
function saveBgPref() { localStorage.setItem('conclave_bg', JSON.stringify(state.bg)); }

// ---------- 消息渲染 ----------
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderCode(text) {
  // 将 ``` 代码块转为 pre/code，并高亮
  const blocks = text.split(String.fromCharCode(96, 96, 96));
  if (blocks.length < 3) return escapeHtml(text).replace(/\n/g, '<br>');
  let html = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 0) {
      html += escapeHtml(blocks[i]).replace(/\n/g, '<br>');
    } else {
      const line = blocks[i];
      const nl = line.indexOf('\n');
      let lang = '', code = line;
      if (nl > -1 && line.slice(0, nl).trim() && !line.slice(0, nl).includes(' ')) {
        lang = line.slice(0, nl).trim(); code = line.slice(nl + 1);
      }
      html += '<pre><code class="language-' + lang + '">' + escapeHtml(code) + '</code></pre>';
    }
  }
  return html;
}

function addMessage(content, type = 'model', meta = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + type;
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    if (meta.role) metaEl.innerHTML = '<span class="tag">' + escapeHtml(meta.role) + '</span>';
    if (meta.strategy) metaEl.innerHTML += '<span class="tag">合议: ' + escapeHtml(meta.strategy) + '</span>';
    if (meta.fromCache) metaEl.innerHTML += '<span class="tag">⚡ 缓存</span>';
    if (meta.kbHits > 0) metaEl.innerHTML += '<span class="tag">📚 ' + meta.kbHits + '</span>';
    if (meta.searchHits > 0) metaEl.innerHTML += '<span class="tag">🔍 ' + meta.searchHits + '</span>';
    if (meta.toolCalls && meta.toolCalls.length) metaEl.innerHTML += '<span class="tag tool-tag">🛠 ' + meta.toolCalls.length + ' 工具</span>';
    wrap.appendChild(metaEl);
    // 工具调用明细
    if (meta.toolCalls && meta.toolCalls.length) {
      const toolBox = document.createElement('div');
      toolBox.className = 'tool-calls';
      meta.toolCalls.forEach(tc => {
        const row = document.createElement('div');
        row.className = 'tool-row';
        row.textContent = '🛠 调用 ' + (tc.tool || '') + ' ' + (tc.result && tc.result.ok ? '✓ 成功' : '✗ ' + (tc.result && tc.result.error || '失败'));
        toolBox.appendChild(row);
      });
      wrap.appendChild(toolBox);
    }
  }
  const body = document.createElement('div');
  body.innerHTML = renderCode(content);
  wrap.appendChild(body);
  $('#messages').appendChild(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  // 高亮
  if (window.hljs && typeof hljs.highlightElement === 'function') { wrap.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch (e) {} }); }
}

function addSystem(content, type = 'system') {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + type;
  wrap.innerHTML = escapeHtml(content);
  $('#messages').appendChild(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg model';
  wrap.id = 'typing';
  wrap.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  $('#messages').appendChild(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return wrap;
}

// ---------- 工作流面板 ----------
let wfState = { active: false, phases: [], phaseIdx: 0, tools: {} };

function showWorkflow() {
  wfState = { active: true, phases: [], phaseIdx: 0, tools: {} };
  $('#workflow-panel').classList.remove('hidden');
  $('#wf-phases').innerHTML = '';
  $('#wf-tools').innerHTML = '';
}

function hideWorkflow() { $('#workflow-panel').classList.add('hidden'); }

function renderWfPhases() {
  const box = $('#wf-phases');
  box.innerHTML = '';
  wfState.phases.forEach((p, i) => {
    const el = document.createElement('span');
    el.className = 'wf-phase' + (i < wfState.phaseIdx ? ' done' : i === wfState.phaseIdx ? ' active' : '');
    el.innerHTML = (i < wfState.phaseIdx ? '✓ ' : i === wfState.phaseIdx ? '<span class="dot"></span>' : '○ ') + escapeHtml(p);
    box.appendChild(el);
  });
}

function wfPhase(name, message) {
  if (!wfState.active) return;
  const idx = wfState.phases.indexOf(name);
  if (idx >= 0) wfState.phaseIdx = idx;
  if (message) $('#wf-phase-name').textContent = message;
  renderWfPhases();
}

function wfTool(tool, status, detail) {
  if (!wfState.active) return;
  const box = $('#wf-tools');
  let el = box.querySelector('[data-tool="' + tool + '"]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'wf-tool';
    el.dataset.tool = tool;
    box.appendChild(el);
  }
  if (status === 'running') {
    el.className = 'wf-tool running';
    el.innerHTML = '<span class="spin">⟳</span> ' + escapeHtml(detail || tool);
  } else {
    el.className = 'wf-tool done';
    el.innerHTML = '✓ ' + escapeHtml(detail || tool);
  }
}

// ---------- 渲染辅助 ----------
// 创建 Think 思考折叠行
function createThinkRow(text, running) {
  const details = document.createElement('details');
  details.className = 'think-row';
  details.setAttribute('data-state', running ? 'running' : 'ok');
  const firstLine = (s) => { const i = s.indexOf('\n'); return i === -1 ? s : s.slice(0, i); };
  const latestLine = (s) => { const t = s.trimEnd(); const i = t.lastIndexOf('\n'); return i === -1 ? t : t.slice(i + 1); };
  const summary = running ? latestLine(text) : firstLine(text);
  details.innerHTML =
    '<summary>' +
      '<span class="think-icon">💭</span>' +
      '<span class="think-title">Think</span>' +
      '<span class="think-sep"></span>' +
      '<span class="think-summary" data-follow-end="' + (running ? 'true' : '') + '">' + escapeHtml(summary) + '</span>' +
      '<span class="think-chevron">›</span>' +
    '</summary>' +
    '<div class="think-body"></div>';
  details.querySelector('.think-body').textContent = text;
  return details;
}

// 更新 Think 行的摘要（流式时跟随最新行）
function updateThinkRow(details, text, running) {
  const latestLine = (s) => { const t = s.trimEnd(); const i = t.lastIndexOf('\n'); return i === -1 ? t : t.slice(i + 1); };
  details.querySelector('.think-body').textContent = text;
  if (running) {
    const sum = details.querySelector('.think-summary');
    sum.textContent = latestLine(text);
    sum.setAttribute('data-follow-end', 'true');
  }
}

// 创建命令/工具卡片
function createCommandCard({ name, state, summary, detail }) {
  const card = document.createElement('div');
  card.className = 'cmd-card';
  card.setAttribute('data-state', state); // running | ok | error
  if (state === 'running') {
    card.innerHTML =
      '<summary class="cmd-row">' +
        '<span class="cmd-icon">⇄</span>' +
        '<span class="cmd-title">' + escapeHtml(name) + '</span>' +
        '<span class="cmd-sep"></span>' +
        '<span class="cmd-summary">' + escapeHtml(summary || '运行中…') + '</span>' +
      '</summary>';
  } else {
    const icon = state === 'error' ? '✕' : '✓';
    card.innerHTML =
      '<details class="cmd-details">' +
        '<summary class="cmd-row">' +
          '<span class="cmd-icon" data-state="' + state + '">' + icon + '</span>' +
          '<span class="cmd-title">' + escapeHtml(name) + '</span>' +
          '<span class="cmd-sep"></span>' +
          '<span class="cmd-summary" data-error="' + (state === 'error' ? 'true' : '') + '">' + escapeHtml(summary || (state === 'error' ? '失败' : '完成')) + '</span>' +
          '<span class="cmd-chevron">›</span>' +
        '</summary>' +
        '<pre class="cmd-body">' + escapeHtml(detail || summary || '') + '</pre>' +
      '</details>';
  }
  return card;
}

// ---------- 发送（流式） ----------
async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoResize();
  addMessage(text, 'user', { role: '我' });
  showWorkflow();
  addTyping();
  $('#send-btn').disabled = true;
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: state.sessionId, modelId: $('#model-select')?.value || '' })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let meta = {};
    // 创建模型消息容器
    $('#typing').remove();
    let modelMsg = null;
    const cmdCards = new Map(); // tool名 -> 卡片元素
    const toolOrder = [];       // 工具调用顺序（用于分组）
    let thinkRow = null;        // 当前 Think 折叠行

    const flushEvent = (event, data) => {
      if (event === 'plan') {
        wfState.phases = data.phases || []; wfState.phaseIdx = 0;
        renderWfPhases();
      } else if (event === 'status') {
        wfPhase(data.phase, data.message);
      } else if (event === 'tool_call') {
        // 命令卡片（工具调用分组展示）
        const name = data.tool || 'tool';
        const isModel = name.startsWith('model:');
        if (data.status === 'running' && !isModel) {
          if (!cmdCards.has(name)) {
            const card = createCommandCard({ name, state: 'running', summary: data.detail || '运行中…' });
            if (modelMsg && toolOrder.length > 0) modelMsg.appendChild(card);
            else $('#messages').appendChild(card);
            cmdCards.set(name, card);
            toolOrder.push(name);
          } else {
            const card = cmdCards.get(name);
            card.setAttribute('data-state', 'running');
            card.innerHTML = '<summary class="cmd-row">' +
              '<span class="cmd-icon">⇄</span>' +
              '<span class="cmd-title">' + escapeHtml(name) + '</span>' +
              '<span class="cmd-sep"></span>' +
              '<span class="cmd-summary">' + escapeHtml(data.detail || '运行中…') + '</span>' +
            '</summary>';
          }
        } else if (data.status === 'done' && !isModel) {
          let card = cmdCards.get(name);
          if (!card) {
            card = createCommandCard({ name, state: 'ok', summary: data.detail || '完成' });
            $('#messages').appendChild(card);
            cmdCards.set(name, card);
            toolOrder.push(name);
          } else {
            card.setAttribute('data-state', data.error ? 'error' : 'ok');
            const summary = data.detail || (data.error ? '失败' : '完成');
            card.innerHTML =
              '<details class="cmd-details"' + (data.error ? ' data-error="true"' : '') + '>' +
                '<summary class="cmd-row">' +
                  '<span class="cmd-icon" data-state="' + (data.error ? 'error' : 'ok') + '">' + (data.error ? '✕' : '✓') + '</span>' +
                  '<span class="cmd-title">' + escapeHtml(name) + '</span>' +
                  '<span class="cmd-sep"></span>' +
                  '<span class="cmd-summary" data-error="' + (data.error ? 'true' : '') + '">' + escapeHtml(summary) + '</span>' +
                  '<span class="cmd-chevron">›</span>' +
                '</summary>' +
                '<pre class="cmd-body">' + escapeHtml(data.detail || summary) + '</pre>' +
              '</details>';
          }
        }
        // 工作流小条仍保留
        wfTool(data.tool, data.status, data.detail);
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else if (event === 'approval/request') {
        // 危险操作审批：弹窗让用户允许/拒绝（决策 POST 到 /api/approval/decide）
        const reason = data.reason || ('工具 ' + (data.toolName || '') + ' 请求执行');
        const allowed = window.confirm('⚠️ 需要确认\n\n' + reason + '\n\n是否允许执行？');
        fetch('/api/approval/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.id, allowed })
        }).catch((e) => console.error('审批决策提交失败', e));
        if (modelMsg) { /* keep context */ }
      } else if (event === 'think') {
        // Think 思考折叠行
        if (!thinkRow) {
          thinkRow = createThinkRow(data.text || '', true);
          if (modelMsg) modelMsg.appendChild(thinkRow);
          else $('#messages').appendChild(thinkRow);
        } else {
          updateThinkRow(thinkRow, data.text || '', true);
        }
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else if (event === 'token') {
        finalText += data.delta;
        if (!modelMsg) {
          modelMsg = document.createElement('div');
          modelMsg.className = 'msg model';
          $('#messages').appendChild(modelMsg);
        }
        // 正文 + 流式光标（简单可靠）
        let body = modelMsg.querySelector('.msg-body');
        if (!body) { body = document.createElement('div'); body.className = 'msg-body'; modelMsg.appendChild(body); }
        const oldCur = body.querySelector('.stream-cursor');
        if (oldCur) oldCur.remove();
        const p = document.createElement('p');
        p.textContent = finalText;
        const c = document.createElement('span');
        c.className = 'stream-cursor';
        p.appendChild(c);
        body.innerHTML = '';
        body.appendChild(p);
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else if (event === 'done') {
        meta = data;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const lines = part.split('\n');
        const evLine = lines.find(l => l.startsWith('event:'));
        const dataLine = lines.find(l => l.startsWith('data:'));
        if (!evLine || !dataLine) continue;
        const event = evLine.slice(6).trim();
        const data = JSON.parse(dataLine.slice(5).trim());
        flushEvent(event, data);
      }
    }
    // 最终整理（Markdown 正文，保留命令卡片）
    if (modelMsg) {
      // done 事件带 reasoning 但 think 行未创建时补充（settled 态）
      if (meta.reasoning && !thinkRow) {
        thinkRow = createThinkRow(meta.reasoning, false);
        modelMsg.insertBefore(thinkRow, modelMsg.firstChild);
      }
      if (thinkRow) thinkRow.setAttribute('data-state', 'ok');
      const body = modelMsg.querySelector('.msg-body');
      if (body) {
        // 去掉流式光标
        const cur = body.querySelector('.stream-cursor');
        if (cur) cur.remove();
        body.innerHTML = renderCode(finalText || '');
      } else {
        modelMsg.innerHTML = renderCode(finalText || '');
      }
      if (window.hljs && typeof hljs.highlightElement === 'function') modelMsg.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b); } catch(e){} });
      // 无内容时给个占位
      if (!finalText && !cmdCards.size) modelMsg.innerHTML = '<div class="msg-body"><p>（空回复）</p></div>';
    } else if (finalText) {
      addMessage(finalText, 'model', {});
    }
    hideWorkflow();
  } catch (e) {
    $('#typing').remove();
    hideWorkflow();
    if (e.message !== 'AUTH_REQUIRED') addSystem('请求失败: ' + e.message, 'error');
  } finally {
    $('#send-btn').disabled = false;
    loadStatus();
  }
}

function autoResize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

// ---------- 加载状态 ----------
// 加载并渲染历史会话分组列表（左侧栏）
async function loadSessionHistory() {
  const box = $('#ls-history');
  if (!box) return;
  try {
    const s = await api('/api/session');
    const groups = s.groups || [];
    box.innerHTML = '';
    if (!groups.length) {
      box.innerHTML = '<div class="ls-group-title">暂无历史会话</div>';
      return;
    }
    groups.forEach(g => {
      const groupEl = document.createElement('div');
      groupEl.className = 'ls-group';
      groupEl.innerHTML = '<div class="ls-group-title">' + escapeHtml(g.group) + '</div>';
      g.sessions.forEach(sess => {
        const item = document.createElement('div');
        item.className = 'ls-item' + (sess.id === state.sessionId ? ' active' : '');
        item.dataset.id = sess.id;
        const d = new Date(sess.updatedAt);
        const time = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        item.innerHTML = '<span class="ls-item-title">' + escapeHtml(sess.title || '新会话') + '</span><span class="ls-item-time">' + time + '</span>';
        groupEl.appendChild(item);
      });
      box.appendChild(groupEl);
    });
  } catch (e) { box.innerHTML = '<div class="ls-group-title">会话列表加载失败</div>'; }
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    // 模式（合议需≥2个有效API，否则置灰锁定为单模型）
    $('#mode-select').value = s.deliberationMode || 'weighted';
    setModeChip(s.canDeliberate ? s.deliberationMode : '单模型直答');
    $('#mode-select').disabled = !s.canDeliberate;
    const modeNote = $('#mode-note');
    if (modeNote) {
      modeNote.textContent = s.canDeliberate
        ? '已启用合议（' + s.effectiveApiCount + ' 个有效API）'
        : '单模型模式：需配置≥2个有效API才可启用合议（当前 ' + s.effectiveApiCount + ' 个）';
    }
    // 思考
    $('#think-slider').value = s.think.level; $('#think-val').textContent = s.think.level; $('#think-chip').textContent = s.think.level;
    $('#think-mode').value = s.think.controlMode || 'native';
    // 角色
    state.roleEnabled = s.roleEnabled;
    renderRoles(s.roles, s.selectedRole, s.roleEnabled);
    $('#role-enable').checked = s.roleEnabled;
    // 权限
    $('#perm-select').value = s.permissions.configured || 'medium';
    $('#cfg-perm').value = s.permissions.configured || 'medium';
    renderPermNote(s.permissions.effective);
    // 知识库/搜索
    $('#rag-enable').checked = s.kb.enabled;
    $('#search-enable').checked = s.features.find(f=>f.id==='search')?.enabled === true;
    $('#kb-info').textContent = s.kb.docs + ' 文档 · ' + s.kb.chunks + ' 片段';
    // 缓存
    $('#cache-rate').textContent = (s.cache.hitRate * 100).toFixed(1) + '%';
    $('#cache-hit').textContent = s.cache.hit;
    $('#cache-miss').textContent = s.cache.miss;
    $('#cache-size').textContent = s.cache.size + '/' + s.cache.maxSize;
    // 风控
    $('#risk-tokens').textContent = (s.risk.tokensUsed / 1000).toFixed(1) + 'K';
    $('#risk-remain').textContent = (s.risk.remaining / 1000).toFixed(0) + 'K';
    // 任务 & 黑名单 & 会话
    $('#task-running').textContent = s.tasks.running;
    $('#blacklist-n').textContent = s.blacklist.length;
    if ($('#session-turns')) $('#session-turns').textContent = s.session ? s.session.totalTurns : 0;
    // 原生
    $('#native-badge').textContent = s.native ? '⚡ C++' : '⛏ JS';
    $('#native-badge').title = s.native ? '原生加速已启用' : '原生扩展未编译，使用 JS 实现';
    // 模型选择器（输入框旁）：列出所有已启用的模型
    const modelSel = $('#model-select');
    if (modelSel && s.models && s.models.length) {
      const prevVal = modelSel.value;
      const enabled = s.models.filter(m => m.enabled !== false);
      modelSel.innerHTML = '<option value="">自动</option>' +
        enabled.map(m => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name || m.model || m.id) + (m.primary ? '（主模型）' : '') + '</option>').join('');
      if (prevVal && enabled.some(m => m.id === prevVal)) modelSel.value = prevVal;
    }
    // 局域网
    $('#cfg-host').value = s.lan.host;
    $('#cfg-port').value = s.lan.port;
    // GUI Agent 状态 + 配置
    if ($('#gui-agent-status')) {
      try {
        const ga = await api('/api/gui/agent/status');
        $('#gui-agent-status').textContent = ga.available
          ? '✅ 可用（vision模型: ' + ga.visionModel + '）' + (ga.active ? ' · 运行中' : '')
          : '⚠️ ' + (ga.reason || '未配置vision模型');
        $('#gui-enable').checked = ga.enabled;
        if (ga.mode === 'interval') $('#gui-mode-interval').checked = true;
        else if (ga.mode === 'auto') $('#gui-mode-auto').checked = true;
        else { $('#gui-mode-interval').checked = false; $('#gui-mode-auto').checked = false; }
        $('#gui-interval').value = ga.interval || 1.0;
        // 聊天框上方的 GUI 模式指示条
        const bar = $('#gui-mode-bar');
        if (bar) {
          if (ga.active) {
            bar.classList.remove('hidden');
            const hint = $('#gui-mode-hint');
            if (hint) hint.textContent = ga.mode === 'interval'
              ? '聊天中可自动调用GUI（定时截图 ' + (ga.interval||1) + ' 次/秒）'
              : '聊天中可自动调用GUI（模型自主截图）';
          } else { bar.classList.add('hidden'); }
        }
      } catch (e) { $('#gui-agent-status').textContent = '⚠️ 需完全访问权限'; }
    }
    // 模型
    renderModels(s.models);
    // 功能开关
    renderFeatures(s.features);
    // 缓存配置
    $('#cfg-cache').checked = s.cache.enabled;
    $('#cfg-cache-size').value = s.cache.maxSize;
    $('#cfg-token-limit').value = s.risk.dailyLimit;
  } catch (e) { console.error('loadStatus', e); }
}

function setModeChip(mode) {
  const map = { fast: '快速返回', equal: '均等投票', weighted: '加权投票', deep: '深度合议' };
  $('#mode-chip').textContent = map[mode] || mode;
}

function renderPermNote(effective) {
  const map = {
    none: '无权限：仅工作区内操作 + 安全命令（不涉及系统底层）',
    medium: '中等：访问所有目录 + 高级Shell + 增删文件（系统核心除外）',
    full: '完全访问：任意命令 / 任意文件 / 系统配置'
  };
  $('#perm-note').textContent = '当前生效: ' + (map[effective] || effective);
}

function renderRoles(roles, selected, enabled) {
  const sel = $('#role-select');
  sel.innerHTML = '';
  // "无角色"选项 = 纯通用大模型（不注入任何系统提示）
  const none = document.createElement('option');
  none.value = ''; none.textContent = '（无角色 · 通用大模型）';
  if (!selected) none.selected = true;
  sel.appendChild(none);
  roles.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name;
    if (r.id === selected) o.selected = true;
    sel.appendChild(o);
  });
  renderPersona(roles.find(r => r.id === selected));
}

function renderPersona(role) {
  const card = $('#persona-card');
  if (!role || !state.roleEnabled) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'flex';
  $('#persona-name').textContent = role.name || '-';
  $('#persona-greeting').textContent = role.greeting || '';
  $('#persona-tone').textContent = role.tone || '';
  const av = $('#persona-avatar');
  if (role.avatar) av.innerHTML = '<img src="' + escapeHtml(role.avatar) + '" alt="avatar">';
  else av.innerHTML = '◆';
}

let editingRoleId = null;

function openRoleModal(role) {
  editingRoleId = role ? role.id : null;
  $('#role-modal-title').textContent = role ? '编辑角色：' + role.name : '新建角色';
  $('#rm-name').value = role ? role.name : '';
  $('#rm-appearance').value = role ? (role.appearance||'') : '';
  $('#rm-tone').value = role ? (role.tone||'') : '';
  $('#rm-greeting').value = role ? (role.greeting||'') : '';
  $('#rm-style').value = role ? (role.style||'') : '';
  $('#rm-rules').value = role ? (role.rules||'') : '';
  $('#rm-forbidden').value = role ? (role.forbidden||'') : '';
  $('#rm-background').value = role ? (role.background||'') : '';
  $('#rm-avatar').value = role ? (role.avatar||'') : '';
  $('#role-modal').classList.remove('hidden');
}

async function saveRoleModal() {
  const body = {
    name: $('#rm-name').value.trim() || '未命名角色',
    appearance: $('#rm-appearance').value.trim(),
    tone: $('#rm-tone').value.trim(),
    greeting: $('#rm-greeting').value.trim(),
    style: $('#rm-style').value.trim(),
    rules: $('#rm-rules').value.trim(),
    forbidden: $('#rm-forbidden').value.trim(),
    background: $('#rm-background').value.trim(),
    avatar: $('#rm-avatar').value.trim()
  };
  try {
    if (editingRoleId) await api('/api/roles/' + encodeURIComponent(editingRoleId), { method: 'PUT', body });
    else await api('/api/roles', { method: 'POST', body });
    $('#role-modal').classList.add('hidden');
    toast('角色已保存');
    loadStatus();
  } catch (e) { toast('保存失败: ' + e.message); }
}

async function deleteCurrentRole() {
  const id = $('#role-select').value;
  if (!id) return;
  if (!confirm('确定删除角色「' + $('#role-select').options[$('#role-select').selectedIndex].text + '」？')) return;
  try {
    await api('/api/roles/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('角色已删除');
    loadStatus();
  } catch (e) { toast('删除失败: ' + e.message); }
}

const GROUP_LABELS = { core: '核心', knowledge: '知识', persona: '人格', security: '安全', economy: '风控', ext: '扩展', ui: '界面' };

function renderFeatures(features) {
  const box = $('#features-list');
  if (!box) return;
  box.innerHTML = '';
  features.forEach(f => {
    const row = document.createElement('div');
    row.className = 'feature-row';
    row.innerHTML = `
      <div class="f-info">
        <b>${escapeHtml(f.label)}</b>
        <span class="f-group">${GROUP_LABELS[f.group] || f.group}</span>
        <p>${escapeHtml(f.desc || '')}</p>
      </div>
      <label class="switch"><input type="checkbox" class="f-toggle" data-id="${f.id}" ${f.enabled?'checked':''} ${f.group==='core'?'disabled':''}><span></span></label>
    `;
    box.appendChild(row);
  });
  box.querySelectorAll('.f-toggle').forEach(t => {
    t.addEventListener('change', async () => {
      try {
        await api('/api/features', { method: 'POST', body: { id: t.dataset.id, enabled: t.checked } });
        toast((t.checked ? '已开启：' : '已关闭：') + GROUP_LABELS[t.dataset.id] || t.dataset.id);
      } catch (e) { toast('操作失败: ' + e.message); t.checked = !t.checked; }
    });
  });
}

function renderModels(models) {
  const box = $('#models-list');
  box.innerHTML = '';
  models.forEach(m => {
    const card = document.createElement('div');
    card.className = 'model-card';
    card.dataset.id = m.id;
    card.innerHTML = `
      <div class="row"><label>名称</label><input class="m-name" value="${escapeHtml(m.name||'')}"></div>
      <div class="row"><label>模型 ID</label>
        <div class="model-id-row">
          <input class="m-model" value="${escapeHtml(m.model||'')}" placeholder="填模型ID，或点右侧自动检测">
          <button class="btn m-detect" type="button" title="自动检测该供应商可用模型">🔍 自动检测</button>
          <select class="m-detect-list hidden" title="选择检测到的模型"></select>
        </div>
      </div>
      <div class="row"><label>Base URL</label><input class="m-base" value="${escapeHtml(m.baseUrl||'')}"></div>
      <div class="row"><label>API Key（可粘贴）</label>
        <div class="key-row">
          <input class="m-key" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(m.apiKey || '')}" placeholder="输入 API Key">
          <button class="btn key-eye" type="button" title="显示/隐藏">👁</button>
        </div>
      </div>
      <div class="row"><label>权重</label><input class="m-weight" type="number" step="0.1" min="0" max="2" value="${m.weight||1}"></div>
      <div class="row"><label>思考控制</label><select class="m-think">
        <option value="native" ${m.think_control_mode==='native'?'selected':''}>native</option>
        <option value="prompt_override" ${m.think_control_mode==='prompt_override'?'selected':''}>prompt_override</option>
      </select></div>
      <label><input type="checkbox" class="m-enable" ${m.enabled?'checked':''}> 启用</label>
      <label><input type="checkbox" class="m-vision" ${m.vision?'checked':''}> 支持图形识别(vision)</label>
      <label><input type="radio" name="primary-model" class="m-primary" value="${escapeHtml(m.id)}" ${m.primary?'checked':''}> 设为主模型（合议协调者）</label>
      <div class="model-actions">
        <button class="btn m-test" style="margin-top:8px">🔌 测试连接</button>
        <button class="btn m-del" style="margin-top:8px">删除</button>
      </div>
      <div class="m-test-result" style="margin-top:6px;font-size:12px"></div>
    `;
    box.appendChild(card);
    card.querySelector('.key-eye').addEventListener('click', () => {
      const k = card.querySelector('.m-key');
      k.type = k.type === 'password' ? 'text' : 'password';
    });
    card.querySelector('.m-test').addEventListener('click', async (e) => {
      const btn = e.target;
      const resultEl = card.querySelector('.m-test-result');
      const cfg = {
        model: card.querySelector('.m-model').value,
        baseUrl: card.querySelector('.m-base').value,
        apiKey: card.querySelector('.m-key').value || (m.apiKey && m.apiKey !== '***' ? m.apiKey : '')
      };
      btn.disabled = true; btn.textContent = '测试中…'; resultEl.textContent = '';
      try {
        const rr = await api('/api/models/test', { method: 'POST', body: cfg });
        if (rr.ok) { resultEl.style.color = 'var(--ok)'; resultEl.textContent = '✅ 连接成功 (' + rr.latency + 'ms, model=' + (rr.model||'') + ')'; }
        else { resultEl.style.color = 'var(--err)'; resultEl.textContent = '❌ 连接失败: ' + (rr.error || '') + ' (' + rr.latency + 'ms)'; }
      } catch (e2) { resultEl.style.color = 'var(--err)'; resultEl.textContent = '❌ ' + e2.message; }
      finally { btn.disabled = false; btn.textContent = '🔌 测试连接'; }
    });
    // 自动检测模型列表
    card.querySelector('.m-detect').addEventListener('click', async (e) => {
      const btn = e.target;
      const sel = card.querySelector('.m-detect-list');
      const cfg = {
        baseUrl: card.querySelector('.m-base').value,
        apiKey: card.querySelector('.m-key').value || (m.apiKey && m.apiKey !== '***' ? m.apiKey : '')
      };
      btn.disabled = true; btn.textContent = '检测中…';
      try {
        const rr = await api('/api/models/list', { method: 'POST', body: cfg });
        if (rr.ok && rr.models && rr.models.length) {
          sel.innerHTML = '<option value="">选择模型（共 ' + rr.count + ' 个）</option>' +
            rr.models.map(x => '<option value="' + escapeHtml(x) + '">' + escapeHtml(x) + '</option>').join('');
          sel.classList.remove('hidden');
          toast('检测到 ' + rr.count + ' 个模型');
        } else {
          sel.classList.add('hidden');
          toast('未检测到模型: ' + (rr.error || ''));
        }
      } catch (e2) { sel.classList.add('hidden'); toast('检测失败: ' + e2.message); }
      finally { btn.disabled = false; btn.textContent = '🔍 自动检测'; }
    });
    // 选择检测到的模型 → 填入输入框
    card.querySelector('.m-detect-list').addEventListener('change', (e) => {
      if (e.target.value) card.querySelector('.m-model').value = e.target.value;
      e.target.classList.add('hidden');
    });
  });
}

// ---------- 设置 ----------
function openSettings() { $('#settings-modal').classList.remove('hidden'); }
function closeSettings() { $('#settings-modal').classList.add('hidden'); }

async function saveModels() {
  const primaryId = document.querySelector('input[name="primary-model"]:checked')?.value;
  const models = $$('.model-card').map(card => ({
    id: card.dataset.id || card.querySelector('.m-name').value,
    name: card.querySelector('.m-name').value,
    model: card.querySelector('.m-model').value,
    baseUrl: card.querySelector('.m-base').value,
    apiKey: card.querySelector('.m-key').value,
    weight: parseFloat(card.querySelector('.m-weight').value) || 1,
    enabled: card.querySelector('.m-enable').checked,
    vision: card.querySelector('.m-vision') ? card.querySelector('.m-vision').checked : false,
    think_control_mode: card.querySelector('.m-think').value,
    primary: card.dataset.id === primaryId || card.querySelector('.m-primary')?.checked
  }));
  try {
    await api('/api/config', { method: 'POST', body: { models } });
    toast('模型已保存' + (primaryId ? '，主模型: ' + primaryId : ''));
  } catch (e) { toast('保存失败: ' + e.message); }
}

async function saveNet() {
  const body = {
    server: { host: $('#cfg-host').value, port: parseInt($('#cfg-port').value) || 3088 }
  };
  const lanEnabled = body.server.host === '0.0.0.0';
  if (lanEnabled) {
    // 触发安全流程
    $('#lan-security-box').classList.remove('hidden');
    const st = await api('/api/auth/status', { _skipAuth: true });
    if (!st.hasPassword) {
      $('#risk-check').classList.remove('hidden');
      $('#set-password-btn').style.display = '';
    }
    return;
  }
  try {
    await api('/api/config', { method: 'POST', body });
    toast('网络设置已保存，重启生效');
  } catch (e) { toast('保存失败: ' + e.message); }
}

// ---------- 初始化 ----------
function init() {
  applyTheme(state.theme);
  loadBgPref();

  // 事件绑定
  $('#theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
  $('#settings-toggle').addEventListener('click', openSettings);
  // 左侧历史会话面板
  $('#new-session-btn2').addEventListener('click', () => newConversation());
  // 移动端左侧栏抽屉开关（顶栏☰）
  if ($('#sidebar-toggle')) $('#sidebar-toggle').addEventListener('click', () => {
    const sb = $('#left-sidebar');
    sb.classList.toggle('open');
    const bd = $('.ls-backdrop');
    if (sb.classList.contains('open')) {
      if (!bd) {
        const b = document.createElement('div');
        b.className = 'ls-backdrop';
        b.addEventListener('click', () => { sb.classList.remove('open'); b.remove(); });
        document.body.appendChild(b);
      }
    } else if (bd) { bd.remove(); }
  });
  $('#ls-settings-btn').addEventListener('click', openSettings);
  // 历史会话点击切换
  $('#ls-history').addEventListener('click', async (e) => {
    const item = e.target.closest('.ls-item');
    if (!item || !item.dataset.id) return;
    switchSession(item.dataset.id);
  });
  // 原顶栏新会话按钮
  const newConversation = async () => {
    try { await api('/api/session/clear', { method: 'POST', body: { sessionId: state.sessionId } }); } catch(e){}
    state.sessionId = 's-' + Date.now().toString(36);
    localStorage.setItem('conclave_session', state.sessionId);
    $('#messages').innerHTML = '';
    addSystem('已开启新会话，上下文已清空');
    loadSessionHistory();
  };
  if ($('#new-session-btn')) $('#new-session-btn').addEventListener('click', newConversation);
  // 切换会话：加载历史消息
  const switchSession = async (id) => {
    state.sessionId = id;
    localStorage.setItem('conclave_session', id);
    $('#messages').innerHTML = '';
    try {
      const r = await api('/api/session/messages', { method: 'POST', body: { sessionId: id } });
      (r.history || []).forEach(h => {
        if (h.role === 'user') addMessage(h.content, 'user', { role: '我' });
        else if (h.role === 'assistant') addMessage(h.content, 'model', {});
      });
    } catch (e) { /* ignore */ }
    // 高亮当前项
    $('.ls-item').forEach(x => x.classList.toggle('active', x.dataset.id === id));
    loadSessionHistory();
  };
  $('#modal-close').addEventListener('click', closeSettings);
  $('#settings-modal').addEventListener('click', (e) => { if (e.target === $('#settings-modal')) closeSettings(); });
  $('#send-btn').addEventListener('click', sendMessage);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#input').addEventListener('input', autoResize);

  // 侧边栏模式
  $('#mode-select').addEventListener('change', async () => {
    const m = $('#mode-select').value; setModeChip(m);
    try { await api('/api/config', { method: 'POST', body: { deliberation: { mode: m } } }); }
    catch(e){ toast(e.message); }
  });
  $('#think-slider').addEventListener('input', () => { $('#think-val').textContent = $('#think-slider').value; $('#think-chip').textContent = $('#think-slider').value; });
  $('#think-slider').addEventListener('change', async () => {
    try { await api('/api/config', { method: 'POST', body: { think: { level: parseInt($('#think-slider').value) } } }); }
    catch(e){ toast(e.message); }
  });
  $('#think-mode').addEventListener('change', async () => {
    try { await api('/api/config', { method: 'POST', body: { think: { controlMode: $('#think-mode').value } } }); }
    catch(e){ toast(e.message); }
  });
  $('#role-select').addEventListener('change', async () => {
    const id = $('#role-select').value;
    try {
      await api('/api/roles/select', { method: 'POST', body: { id } });
      const d = await api('/api/roles');
      renderPersona(d.roles.find(r => r.id === id));
    }
    catch(e){ toast(e.message); }
  });
  $('#role-enable').addEventListener('change', async () => {
    try { await api('/api/roles/enabled', { method: 'POST', body: { enabled: $('#role-enable').checked } }); }
    catch(e){ toast(e.message); }
  });
  $('#role-refresh').addEventListener('click', async () => { await loadStatus(); toast('角色已刷新'); });
  $('#role-new').addEventListener('click', () => openRoleModal(null));
  $('#role-edit').addEventListener('click', async () => {
    const id = $('#role-select').value;
    try {
      const d = await api('/api/roles');
      const role = d.roles.find(r => r.id === id);
      openRoleModal(role);
    } catch (e) { toast(e.message); }
  });
  $('#role-del').addEventListener('click', deleteCurrentRole);
  // AI 角色生成器
  $('#role-gen-btn').addEventListener('click', async () => {
    const desc = $('#role-gen-input').value.trim();
    if (!desc) { toast('请先描述你想要的角色'); return; }
    $('#role-gen-btn').disabled = true;
    $('#role-gen-btn').textContent = '生成中…';
    try {
      const r = await api('/api/roles/generate', { method: 'POST', body: { description: desc } });
      toast('角色「' + r.name + '」已生成并启用');
      $('#role-gen-input').value = '';
      await loadStatus();
    } catch (e) { toast('生成失败: ' + e.message); }
    finally { $('#role-gen-btn').disabled = false; $('#role-gen-btn').textContent = '生成角色'; }
  });
  $('#role-modal-close').addEventListener('click', () => $('#role-modal').classList.add('hidden'));
  $('#role-modal').addEventListener('click', (e) => { if (e.target === $('#role-modal')) $('#role-modal').classList.add('hidden'); });
  $('#rm-save').addEventListener('click', saveRoleModal);
  // GUI Agent 配置（互斥模式）
  const guiSaveConfig = async () => {
    const enabled = $('#gui-enable').checked;
    const mode = enabled ? ($('#gui-mode-interval').checked ? 'interval' : $('#gui-mode-auto').checked ? 'auto' : 'none') : 'none';
    const interval = parseFloat($('#gui-interval').value) || 1.0;
    try {
      await api('/api/gui/agent/config', { method: 'POST', body: { enabled, mode, interval } });
      toast(mode === 'none' ? 'GUI 能力已关闭' : mode === 'interval' ? '定时截图模式已启用（' + interval + ' 次/秒）' : '自动化模式已启用（模型自主截图）');
    } catch (e) { toast('保存失败: ' + e.message); }
  };
  $('#gui-enable').addEventListener('change', () => {
    if (!$('#gui-enable').checked) { $('#gui-mode-interval').checked = false; $('#gui-mode-auto').checked = false; }
    else if (!$('#gui-mode-interval').checked && !$('#gui-mode-auto').checked) $('#gui-mode-interval').checked = true;
    guiSaveConfig();
  });
  // 互斥：选了一个就取消另一个；都不选 = 关闭
  $('#gui-mode-interval').addEventListener('change', (e) => { if (e.target.checked) { $('#gui-mode-auto').checked = false; $('#gui-enable').checked = true; } else if (!$('#gui-mode-auto').checked) { $('#gui-enable').checked = false; } guiSaveConfig(); });
  $('#gui-mode-auto').addEventListener('change', (e) => { if (e.target.checked) { $('#gui-mode-interval').checked = false; $('#gui-enable').checked = true; } else if (!$('#gui-mode-interval').checked) { $('#gui-enable').checked = false; } guiSaveConfig(); });
  $('#gui-interval').addEventListener('change', guiSaveConfig);
  // GUI Agent 运行
  $('#gui-agent-run').addEventListener('click', async () => {
    const task = $('#gui-agent-task').value.trim();
    if (!task) { toast('请描述任务'); return; }
    const logBox = $('#gui-agent-log');
    const btn = $('#gui-agent-run');
    btn.disabled = true; btn.textContent = '运行中…';
    logBox.innerHTML = '<div class="ga-step">⏳ 启动 GUI Agent（截图→识别→操作循环）</div>';
    try {
      const mode = $('#gui-mode-interval').checked ? 'interval' : $('#gui-mode-auto').checked ? 'auto' : 'none';
      const interval = parseFloat($('#gui-interval').value) || 1.0;
      const r = await api('/api/gui/agent', { method: 'POST', body: { task, maxSteps: 8, mode, interval } });
      if (r.ok) {
        logBox.innerHTML = '';
        (r.steps || []).forEach(st => {
          const d = document.createElement('div');
          d.className = 'ga-step' + (st.done ? ' done' : '');
          d.textContent = '步骤' + st.step + ': ' + (st.done ? '✅ ' : '') + (st.action ? (st.action.action + ' ' + (st.action.x!=null?'('+st.action.x+','+st.action.y+')':'') + (st.action.text?' "'+st.action.text+'"':'')) : st.note || '');
          logBox.appendChild(d);
        });
        const fin = document.createElement('div');
        fin.className = 'ga-step done';
        fin.textContent = r.done ? '✅ 任务完成: ' + (r.summary || '') : 'ℹ️ ' + (r.note || '未完成');
        logBox.appendChild(fin);
      } else {
        logBox.innerHTML = '<div class="ga-step">❌ ' + (r.error || '执行失败') + '</div>';
      }
    } catch (e) {
      logBox.innerHTML = '<div class="ga-step">❌ ' + e.message + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '▶ 运行 GUI Agent';
    }
  });
  $('#rag-enable').addEventListener('change', async () => { try { await api('/api/kb/enabled', { method:'POST', body:{ enabled: $('#rag-enable').checked } }); } catch(e){toast(e.message);} });
  $('#search-enable').addEventListener('change', async () => {
    try { await api('/api/config', { method:'POST', body:{ search:{ enabled: $('#search-enable').checked } } }); toast('搜索已' + ($('#search-enable').checked?'开启':'关闭')); }
    catch(e){ toast(e.message); }
  });
  $('#perm-select').addEventListener('change', async () => {
    try { await api('/api/config', { method: 'POST', body: { permissions: $('#perm-select').value } }); await loadStatus(); toast('权限已更新'); }
    catch(e){ toast(e.message); }
  });
  $('#cfg-perm').addEventListener('change', () => { $('#perm-select').value = $('#cfg-perm').value; });

  // 设置 tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $$('.tab-panel').forEach(p => p.classList.add('hidden'));
    $('#panel-' + t.dataset.tab).classList.remove('hidden');
  }));

  // 设置按钮
  $('#add-model-btn').addEventListener('click', () => {
    const box = $('#models-list');
    const card = document.createElement('div');
    card.className = 'model-card';
    card.dataset.id = 'model-' + Date.now();
    card.innerHTML = `
      <div class="row"><label>名称</label><input class="m-name" value="新模型"></div>
      <div class="row"><label>模型 ID</label><input class="m-model" value=""></div>
      <div class="row"><label>Base URL</label><input class="m-base" value="https://api.openai.com/v1"></div>
      <div class="row"><label>API Key（可粘贴）</label>
        <div class="key-row">
          <input class="m-key" type="text" autocomplete="off" spellcheck="false">
          <button class="btn key-eye" type="button" title="显示/隐藏">👁</button>
        </div>
      </div>
      <div class="row"><label>权重</label><input class="m-weight" type="number" step="0.1" min="0" max="2" value="1"></div>
      <div class="row"><label>思考控制</label><select class="m-think">
        <option value="native">native</option><option value="prompt_override">prompt_override</option>
      </select></div>
      <label><input type="checkbox" class="m-enable" checked> 启用</label>
      <label><input type="checkbox" class="m-vision"> 支持图形识别(vision)</label>
      <button class="btn m-del" style="margin-top:8px">删除</button>
    `;
    box.appendChild(card);
    card.querySelector('.key-eye').addEventListener('click', () => {
      const k = card.querySelector('.m-key');
      k.type = k.type === 'password' ? 'text' : 'password';
    });
    card.querySelector('.m-del').addEventListener('click', () => card.remove());
  });
  $('#save-models-btn').addEventListener('click', saveModels);
  $('#save-net-btn').addEventListener('click', saveNet);
  $('#set-password-btn').addEventListener('click', async () => {
    const p = prompt('设置登录密码（至少 4 位，请自行设计）：');
    if (!p) return;
    try {
      await api('/api/setup/password', { method:'POST', body:{ password: p } });
      // 设置密码成功后，自动开放局域网（已满足安全锁要求）
      await api('/api/config', { method:'POST', body:{ server:{ host: $('#cfg-host').value, port: parseInt($('#cfg-port').value)||3088 } } });
      toast('密码已设置，局域网已开放（重启生效）');
      $('#risk-check').classList.add('hidden');
      $('#set-password-btn').style.display = 'none';
    } catch(e){ toast(e.message); }
  });
  $('#confirm-risk-btn').addEventListener('click', async () => {
    if (!$('#risk-ack').checked) { toast('请先勾选确认风险'); return; }
    try {
      await api('/api/setup/risks', { method:'POST', body:{ acknowledged: true } });
      await api('/api/config', { method:'POST', body:{ server:{ host: $('#cfg-host').value, port: parseInt($('#cfg-port').value)||3088 } } });
      toast('已确认风险并开放局域网，重启生效');
    } catch(e){ toast(e.message); }
  });

  // 缓存
  $('#cache-clear-btn').addEventListener('click', async () => { await api('/api/cache/clear',{method:'POST'}); toast('缓存已清空'); loadStatus(); });
  $('#cache-export-btn').addEventListener('click', async () => {
    const r = await api('/api/cache/export');
    const blob = new Blob([r.data], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cache-backup.json'; a.click();
  });
  $('#cache-import-btn').addEventListener('click', () => $('#cache-import-file').click());
  $('#cache-import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    try { await api('/api/cache/import', { method:'POST', body:{ data: text } }); toast('缓存已导入'); loadStatus(); } catch(err){ toast('导入失败: '+err.message); }
  });

  // 主题与背景 + 侧边栏位置
  $$('.theme-btn').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
  $$('.sb-pos').forEach(b => b.addEventListener('click', () => applySidebarPos(b.dataset.pos)));
  applySidebarPos(state.sidebarPos);
  $('#upload-bg-btn').addEventListener('click', () => $('#bg-file').click());
  $('#bg-file').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.bg.url = reader.result; state.bg.enabled = true; applyBg(); saveBgPref(); toast('背景已应用');
    };
    reader.readAsDataURL(f);
  });
  $('#bg-opacity').addEventListener('input', () => { state.bg.opacity = parseInt($('#bg-opacity').value); $('#bg-opacity-val').textContent = state.bg.opacity; applyBg(); saveBgPref(); });
  $('#bg-blur').addEventListener('input', () => { state.bg.blur = parseInt($('#bg-blur').value); $('#bg-blur-val').textContent = state.bg.blur; applyBg(); saveBgPref(); });
  $('#bg-reset-btn').addEventListener('click', () => { state.bg = { enabled:false, url:'', opacity:30, blur:0 }; saveBgPref(); applyBg(); toast('已恢复默认背景'); });
  $('#save-all-btn').addEventListener('click', async () => {
    try {
      await api('/api/config', { method:'POST', body:{
        cache:{ enabled: $('#cfg-cache').checked, maxSize: parseInt($('#cfg-cache-size').value)||500 },
        risk:{ dailyTokenLimit: parseInt($('#cfg-token-limit').value)||1000000 },
        permissions: $('#cfg-perm').value,
        ui:{ theme: state.theme }
      }});
      await saveModels();
      toast('设置已保存');
      closeSettings();
      loadStatus();
    } catch(e){ toast('保存失败: '+e.message); }
  });

  // 首次加载
  loadStatus();
  loadSessionHistory();
  autoResize();
}

document.addEventListener('DOMContentLoaded', init);
