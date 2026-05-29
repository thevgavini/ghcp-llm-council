// Module-level state, render-on-event.
const state = {
  config: null,
  conversations: [],
  currentId: null,
  conversation: null,
  activeStage: null  // user-selected tab; null = follow turn.stage
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- WebSocket -------------------------------------------------------------
function connectWs() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'turn-update') {
      if (state.currentId == null) {
        // Auto-select the conversation that just got an update
        state.currentId = msg.conversation_id;
      }
      if (state.currentId === msg.conversation_id) {
        state.conversation = await api('GET', `/api/conversations/${msg.conversation_id}`);
        state.conversations = await api('GET', '/api/conversations');
        render();
      }
    } else if (msg.type === 'conversation-created') {
      state.conversations = await api('GET', '/api/conversations');
      if (state.currentId == null) {
        await selectConversation(msg.conversation_id);
      } else {
        renderSidebar();
      }
    } else if (msg.type === 'config-changed') {
      state.config = await api('GET', '/api/config');
      renderSettings();
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1500));
}

// ---- Init ------------------------------------------------------------------
async function init() {
  state.config = await api('GET', '/api/config');
  state.conversations = await api('GET', '/api/conversations');
  if (state.conversations.length) {
    await selectConversation(state.conversations[0].id);
  }
  render();
  connectWs();
  bindEvents();
}

async function selectConversation(cid) {
  state.currentId = cid;
  state.activeStage = null;  // reset to "follow turn.stage" on conversation switch
  state.conversation = await api('GET', `/api/conversations/${cid}`);
  render();
}

// ---- Render ----------------------------------------------------------------
function render() {
  renderSidebar();
  if (!state.conversation) {
    $('#empty').hidden = false;
    $('#conversation').hidden = true;
    return;
  }
  $('#empty').hidden = true;
  $('#conversation').hidden = false;
  const turn = state.conversation.turns.at(-1);
  $('#conv-question').textContent = turn.question;
  $('#conv-meta').innerHTML = metaHtml(turn);
  $('#stage-rail').innerHTML = stageRailHtml(turn);
  $('#stage-content').innerHTML = stageContentHtml(turn);
  bindStageClicks(turn);
  bindCardClicks();
}

function renderSidebar() {
  const html = state.conversations.map((c) => `
    <button class="item ${c.id === state.currentId ? 'active' : ''}" data-id="${c.id}">
      ${escapeHtml(c.title)}
      <span class="date">${new Date(c.created_at).toLocaleString()}</span>
    </button>
  `).join('');
  $('#history').innerHTML = html || '<div class="muted" style="padding:8px">No conversations yet.</div>';
  $$('#history .item').forEach((el) => el.addEventListener('click', () => selectConversation(el.dataset.id)));
}

function metaHtml(turn) {
  const live = turn.councillors.filter((c) => c.status === 'ok').length;
  return `<span>${live}/${turn.councillors.length || (state.config?.council.length || 0)} councillors</span>
          <span>·</span>
          <span>Chairman · ${escapeHtml(state.config?.chairman || '')}</span>`;
}

function stageRailHtml(turn) {
  const active = effectiveStage(turn);
  const stages = [
    { n: '01', t: 'First Opinions',   reached: 1, done: turn.stage >= 2 },
    { n: '02', t: 'Peer Review',       reached: 2, done: turn.stage >= 3 },
    { n: '03', t: "Chairman's Synthesis", reached: 3, done: !!turn.synthesis }
  ];
  return stages.map((s) => `
    <div class="stage ${active === s.reached ? 'active' : ''}" data-stage="${s.reached}" role="button" tabindex="0">
      <div class="stage-meta"><span class="num">${s.n}</span><span>Stage</span></div>
      <div class="stage-title">${s.t}</div>
      <div class="stage-status">${s.done ? '<span class="check">✓</span> Done' : (turn.stage === s.reached ? '<span class="pulse"></span> In progress' : 'Pending')}</div>
    </div>
  `).join('');
}

function effectiveStage(turn) {
  if (state.activeStage != null) return state.activeStage;
  // Default: show the most-advanced reachable stage with content
  if (turn.synthesis) return 3;
  if (turn.stage >= 2 || turn.rankings?.length) return 2;
  return 1;
}

function bindStageClicks(turn) {
  $$('#stage-rail .stage').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeStage = Number(el.dataset.stage);
      // Re-render only the rail + content (cheap, preserves scroll)
      $('#stage-rail').innerHTML = stageRailHtml(turn);
      $('#stage-content').innerHTML = stageContentHtml(turn);
      bindStageClicks(turn);
      bindCardClicks();
    });
  });
}

function stageContentHtml(turn) {
  const s = effectiveStage(turn);
  if (s === 3) return stage3Html(turn);
  if (s === 2) return stage2Html(turn);
  return stage1Html(turn);
}

function stage1Html(turn) {
  const knownCouncil = state.config?.council || [];
  const rows = (turn.councillors.length ? turn.councillors : knownCouncil.map((c) => ({ id: c.id, status: 'thinking' })));
  return `<div class="councillors">${rows.map((c) => councillorCardHtml(c, knownCouncil)).join('')}</div>`;
}

function councillorCardHtml(c, council) {
  const meta = council.find((x) => x.id === c.id) || { vendor: 'Other', display: c.id };
  const initial = (meta.display || c.id).slice(0, 1).toUpperCase();
  if (c.status === 'ok') {
    return `
      <div class="councillor" data-id="${c.id}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id}</div>
          </div>
          <div class="latency">${c.latency_ms ? (c.latency_ms / 1000).toFixed(1) + 's' : ''}</div>
          <span class="check">✓</span>
        </div>
        <div class="response">${marked.parse(c.response || '')}</div>
        <div class="expand-row">Read full response →</div>
      </div>`;
  }
  if (c.status === 'timeout' || c.status === 'error' || c.status === 'empty' || c.status === 'unsupported_model') {
    return `
      <div class="councillor" data-id="${c.id}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id} — ${c.status}</div>
          </div>
          <span class="fail">!</span>
        </div>
        <button class="btn ghost" data-action="retry-councillor" data-id="${c.id}">Retry councillor</button>
      </div>`;
  }
  return `
    <div class="councillor" data-id="${c.id}">
      <div class="councillor-head">
        <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
        <div class="name-block">
          <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
          <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id}</div>
        </div>
      </div>
      <div class="thinking-label"><span class="pulse"></span>THINKING</div>
      <div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
    </div>`;
}

function stage2Html(turn) {
  const council = state.config?.council || [];
  const rankerNodes = turn.rankings.length ? turn.rankings.map((r) => `
    <div class="councillor">
      <div class="councillor-head">
        <div class="name-block">
          <div class="councillor-name">${escapeHtml(council.find((c)=>c.id===r.ranker)?.display || r.ranker)}'s ballot</div>
          <div class="vendor-tag">${r.ranker}</div>
        </div>
      </div>
      <div class="response expanded">${marked.parse(r.raw || '')}</div>
      <div class="muted" style="margin-top:8px">Parsed: ${r.parsed.join(' › ') || '(unparseable)'}</div>
    </div>
  `).join('') : '<div class="muted">Rankings still coming in…</div>';

  const agg = turn.aggregate?.length ? `
    <div class="aggregate"><table>
      <thead><tr><th>Rank</th><th>Model</th><th>Avg position</th><th>Votes</th></tr></thead>
      <tbody>${turn.aggregate.map((a, i) => `<tr><td class="num">${i+1}</td><td>${escapeHtml(council.find((c)=>c.id===a.model)?.display || a.model)}</td><td class="num">${a.avg.toFixed(2)}</td><td class="num">${a.votes}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  return `<div class="councillors">${rankerNodes}</div>${agg}`;
}

function stage3Html(turn) {
  if (!turn.synthesis) return '<div class="muted">Chairman is synthesising…</div>';
  if (turn.synthesis.error) return `<div class="synthesis" style="border-color:var(--bad)"><div class="synthesis-label" style="color:var(--bad)">Chairman failed</div><div class="synthesis-body">${escapeHtml(turn.synthesis.error)}</div></div>`;
  return `<div class="synthesis">
    <div class="synthesis-label">Chairman · ${escapeHtml(turn.synthesis.model)}</div>
    <div class="synthesis-body">${marked.parse(turn.synthesis.text || '')}</div>
  </div>`;
}

function bindCardClicks() {
  $$('#stage-content .councillor').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      el.querySelector('.response')?.classList.toggle('expanded');
    });
  });
  $$('#stage-content [data-action="retry-councillor"]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await api('POST', '/api/events', {
        type: 'retry-councillor',
        conversation_id: state.currentId,
        turn_id: state.conversation.turns.at(-1).id,
        councillor_id: b.dataset.id
      });
    });
  });
}

// ---- Composer (follow-ups) -------------------------------------------------
async function submitFollowUp(q) {
  // Create a new turn on the current conversation so the UI immediately shows it.
  const turn = await api('POST', `/api/conversations/${state.currentId}/turns`, { question: q });
  // Notify any orchestrator listening on the events file.
  await api('POST', '/api/events', {
    type: 'follow-up',
    conversation_id: state.currentId,
    turn_id: turn.id,
    question: q
  });
  state.activeStage = 1;
}

async function startNewConversation(q) {
  const conv = await api('POST', '/api/conversations', { question: q });
  const turn = await api('POST', `/api/conversations/${conv.id}/turns`, { question: q });
  await api('POST', '/api/events', {
    type: 'new-conversation',
    conversation_id: conv.id,
    turn_id: turn.id,
    question: q
  });
  state.activeStage = 1;
  await selectConversation(conv.id);
}

// ---- Settings drawer -------------------------------------------------------
function renderSettings() {
  if (!state.config) return;
  const cfg = state.config;
  const chair = $('#settings-chairman');
  chair.innerHTML = cfg.council.map((c) => `<option value="${c.id}" ${c.id===cfg.chairman?'selected':''}>${escapeHtml(c.display)}</option>`).join('');
  $('#settings-min').value = cfg.min_responses_to_proceed;
  $('#settings-timeout').value = cfg.councillor_timeout_seconds;
  $('#settings-councillors').innerHTML = cfg.council.map((c, i) => `
    <div class="councillor-row">
      <input data-i="${i}" data-k="display" value="${escapeHtml(c.display)}">
      <input data-i="${i}" data-k="id" value="${escapeHtml(c.id)}">
      <input data-i="${i}" data-k="vendor" value="${escapeHtml(c.vendor)}">
      <button type="button" data-remove="${i}">×</button>
    </div>
  `).join('') + '<button type="button" id="add-councillor" class="btn ghost">+ Add councillor</button>';
}

function bindEvents() {
  $('#new-conversation').addEventListener('click', async () => {
    const q = window.prompt('What would you like to ask the council?');
    if (q && q.trim()) {
      await startNewConversation(q.trim());
    }
  });
  $('#open-settings').addEventListener('click', () => { $('#settings-drawer').hidden = false; renderSettings(); });
  $('#close-settings').addEventListener('click', () => { $('#settings-drawer').hidden = true; });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#composer-input').value.trim();
    if (!v || !state.currentId) return;
    $('#composer-input').value = '';
    await submitFollowUp(v);
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = JSON.parse(JSON.stringify(state.config));
    cfg.chairman = $('#settings-chairman').value;
    cfg.min_responses_to_proceed = Number($('#settings-min').value);
    cfg.councillor_timeout_seconds = Number($('#settings-timeout').value);
    $$('#settings-councillors .councillor-row').forEach((row, i) => {
      $$('input', row).forEach((inp) => { cfg.council[i][inp.dataset.k] = inp.value; });
    });
    try {
      await api('PUT', '/api/config', cfg);
      $('#settings-status').textContent = 'Saved. Takes effect on next question.';
    } catch (err) {
      $('#settings-status').textContent = err.message;
    }
  });
  $('#settings-councillors').addEventListener('click', (e) => {
    const rm = e.target.dataset.remove;
    if (rm !== undefined) {
      state.config.council.splice(Number(rm), 1);
      renderSettings();
    }
    if (e.target.id === 'add-councillor') {
      state.config.council.push({ id: 'new-model-id', vendor: 'Other', display: 'New Councillor' });
      renderSettings();
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

init().catch((e) => console.error(e));
