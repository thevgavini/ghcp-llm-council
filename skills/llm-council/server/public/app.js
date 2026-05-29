// Module-level state, render-on-event.
const state = {
  config: null,
  conversations: [],
  currentId: null,
  conversation: null,
  activeStages: {},  // turn_id -> stage number selected by user; absent = follow turn.stage
  csrfToken: null,   // fetched from /api/health on init; required for mutating requests
  models: null       // { task: [...], 'github-models': [...] } populated from /api/models
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && state.csrfToken) {
    headers['X-Council-Token'] = state.csrfToken;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
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
  // /api/health is the same-origin endpoint that returns the CSRF token.
  // Cross-origin pages cannot read this response, which is what defeats CSRF.
  const health = await api('GET', '/api/health');
  state.csrfToken = health && health.csrf_token;
  // Tolerate older servers that don't yet expose /api/models — settings will
  // fall back to preserving custom IDs only, but the rest of the UI still loads.
  try { state.models = await api('GET', '/api/models'); } catch { state.models = { task: [], 'github-models': [] }; }
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
  state.activeStages = {};  // reset per-turn tab selections on conversation switch
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

  const conv = state.conversation;
  const turns = conv.turns;
  const latest = turns.at(-1);

  // Top header shows the *first* question (the conversation's reason for being)
  // and overall meta. Each turn underneath has its own question + stage rail.
  $('#conv-question').textContent = turns[0]?.question ?? '';
  $('#conv-meta').innerHTML = metaHtml(latest);

  // Render the stack of turns into a container that replaces the old single
  // stage-rail + stage-content pair.
  $('#stage-rail').innerHTML = '';
  $('#stage-content').innerHTML = turns.map(turnBlockHtml).join('');

  turns.forEach((t) => {
    bindStageClicks(t);
  });
  bindCardClicks();

  // Scroll latest turn into view if this was a new-turn event
  const lastEl = document.getElementById(`turn-${latest.id}`);
  if (lastEl && turns.length > 1) lastEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function turnBlockHtml(turn, idx) {
  const isFirst = idx === 0;
  const heading = isFirst
    ? ''
    : `<div class="turn-header">
         <div class="eyebrow">Follow-up #${idx}</div>
         <h2 class="turn-question">${escapeHtml(turn.question)}</h2>
       </div>`;
  return `
    <section class="turn-block" id="turn-${turn.id}">
      ${heading}
      <div class="stage-rail" data-turn="${turn.id}" data-rail>${stageRailHtml(turn)}</div>
      <div class="stage-content" data-turn="${turn.id}" data-content>${stageContentHtml(turn)}</div>
    </section>
  `;
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
  if (state.activeStages[turn.id] != null) return state.activeStages[turn.id];
  // Default: show the most-advanced reachable stage with content
  if (turn.synthesis) return 3;
  if (turn.stage >= 2 || turn.rankings?.length) return 2;
  return 1;
}

function bindStageClicks(turn) {
  const railEl = document.querySelector(`[data-rail][data-turn="${turn.id}"]`);
  const contentEl = document.querySelector(`[data-content][data-turn="${turn.id}"]`);
  if (!railEl) return;
  railEl.querySelectorAll('.stage').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeStages[turn.id] = Number(el.dataset.stage);
      railEl.innerHTML = stageRailHtml(turn);
      contentEl.innerHTML = stageContentHtml(turn);
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
  // FIX (issue 1): always render the full council list. For councillors that
  // haven't reported yet, render a skeleton placeholder so the UI stays
  // visually anchored as responses stream in one at a time.
  const byId = new Map(turn.councillors.map((c) => [c.id, c]));
  const rows = knownCouncil.length
    ? knownCouncil.map((cfg) => byId.get(cfg.id) || { id: cfg.id, status: 'thinking' })
    : turn.councillors;
  // Append any councillors that responded but aren't in the configured list
  // (shouldn't happen in practice but keeps the UI honest).
  for (const c of turn.councillors) {
    if (!knownCouncil.find((cfg) => cfg.id === c.id)) rows.push(c);
  }
  return `<div class="councillors">${rows.map((c) => councillorCardHtml(c, knownCouncil)).join('')}</div>`;
}

function councillorCardHtml(c, council) {
  const meta = council.find((x) => x.id === c.id) || { vendor: 'Other', display: c.id };
  const initial = (meta.display || c.id).slice(0, 1).toUpperCase();
  if (c.status === 'ok') {
    return `
      <div class="councillor" data-id="${escapeHtml(c.id)}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${escapeHtml(meta.vendor)}">${escapeHtml(initial)}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${escapeHtml(meta.vendor.toLowerCase())} · ${escapeHtml(c.id)}</div>
          </div>
          <div class="latency">${c.latency_ms ? (c.latency_ms / 1000).toFixed(1) + 's' : ''}</div>
          <span class="check">✓</span>
        </div>
        <div class="response">${safeMd(c.response || '')}</div>
        <div class="expand-row" data-expand>Read full response →</div>
      </div>`;
  }
  if (c.status === 'timeout' || c.status === 'error' || c.status === 'empty' || c.status === 'unsupported_model') {
    return `
      <div class="councillor" data-id="${escapeHtml(c.id)}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${escapeHtml(meta.vendor)}">${escapeHtml(initial)}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${escapeHtml(meta.vendor.toLowerCase())} · ${escapeHtml(c.id)} — ${escapeHtml(c.status)}</div>
          </div>
          <span class="fail">!</span>
        </div>
        <button class="btn ghost" data-action="retry-councillor" data-id="${escapeHtml(c.id)}">Retry councillor</button>
      </div>`;
  }
  return `
    <div class="councillor" data-id="${escapeHtml(c.id)}">
      <div class="councillor-head">
        <div class="avatar" data-vendor="${escapeHtml(meta.vendor)}">${escapeHtml(initial)}</div>
        <div class="name-block">
          <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
          <div class="vendor-tag">${escapeHtml(meta.vendor.toLowerCase())} · ${escapeHtml(c.id)}</div>
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
          <div class="vendor-tag">${escapeHtml(r.ranker)}</div>
        </div>
      </div>
      <div class="response expanded">${safeMd(r.raw || '')}</div>
      <div class="muted" style="margin-top:8px">Parsed: ${r.parsed.length ? r.parsed.map(escapeHtml).join(' › ') : '(unparseable)'}</div>
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
    <div class="synthesis-body">${safeMd(turn.synthesis.text || '')}</div>
  </div>`;
}

function bindCardClicks() {
  $$('#stage-content .councillor').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      const resp = el.querySelector('.response');
      if (!resp) return;
      const nowExpanded = resp.classList.toggle('expanded');
      // FIX (issue 2): toggle the affordance text so the user knows the
      // click did something and how to reverse it.
      const tag = el.querySelector('[data-expand]');
      if (tag) tag.textContent = nowExpanded ? 'Show less ↑' : 'Read full response →';
    });
  });
  $$('#stage-content [data-action="retry-councillor"]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const turnId = b.closest('[data-content]')?.dataset.turn
                  ?? state.conversation.turns.at(-1).id;
      await api('POST', '/api/events', {
        type: 'retry-councillor',
        conversation_id: state.currentId,
        turn_id: turnId,
        councillor_id: b.dataset.id
      });
    });
  });
}

async function startNewConversation_REMOVED() {
  // Browser-initiated new conversation is intentionally disabled in v0.1.
  // Every question comes through the Copilot CLI; this stub is left for
  // future re-introduction once orchestrator auto-dispatch is wired up.
}

async function submitFollowUp_REMOVED() {
  // Browser-initiated follow-ups are intentionally disabled in v0.1.
}

// ---- Settings drawer -------------------------------------------------------
function renderSettings() {
  if (!state.config) return;
  const cfg = state.config;
  const chair = $('#settings-chairman');
  chair.innerHTML = cfg.council.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id===cfg.chairman?'selected':''}>${escapeHtml(c.display)}</option>`).join('');
  $('#settings-min').value = cfg.min_responses_to_proceed;
  $('#settings-timeout').value = cfg.councillor_timeout_seconds;
  $('#settings-councillors').innerHTML = cfg.council.map((c, i) => councillorRowHtml(c, i)).join('') +
    `<button type="button" id="add-councillor" class="btn ghost" style="margin-top:8px">+ Add councillor</button>`;
}

function councillorRowHtml(c, i) {
  const backend = c.backend || 'task';
  const backendOptions = Object.keys(state.models || {}).map((b) =>
    `<option value="${escapeHtml(b)}" ${b===backend?'selected':''}>${escapeHtml(backendLabel(b))}</option>`
  ).join('');
  const modelOptions = modelOptionsHtml(backend, c.id);
  return `
    <div class="councillor-row" data-i="${i}">
      <label class="row-field">
        <span class="row-label">Backend</span>
        <select data-k="backend" data-i="${i}">${backendOptions}</select>
      </label>
      <div class="row-line">
        <label class="row-field">
          <span class="row-label">Model</span>
          <select data-k="model" data-i="${i}">${modelOptions}</select>
        </label>
        <button type="button" class="row-remove" data-remove="${i}" title="Remove councillor">×</button>
      </div>
      <label class="row-field">
        <span class="row-label">Display name</span>
        <input data-k="display" data-i="${i}" value="${escapeHtml(c.display)}">
      </label>
    </div>`;
}

function backendLabel(b) {
  if (b === 'task') return 'Copilot CLI (Anthropic / OpenAI)';
  if (b === 'github-models') return 'GitHub Models (Meta / DeepSeek / Mistral / …)';
  return b;
}

function modelOptionsHtml(backend, selectedId) {
  const models = (state.models && state.models[backend]) || [];
  // Group by vendor for a nicer dropdown UX.
  const byVendor = new Map();
  for (const m of models) {
    if (!byVendor.has(m.vendor)) byVendor.set(m.vendor, []);
    byVendor.get(m.vendor).push(m);
  }
  let html = '';
  let foundSelected = false;
  for (const [vendor, list] of byVendor) {
    html += `<optgroup label="${escapeHtml(vendor)}">`;
    for (const m of list) {
      const sel = m.id === selectedId;
      if (sel) foundSelected = true;
      html += `<option value="${escapeHtml(m.id)}" data-vendor="${escapeHtml(m.vendor)}" data-display="${escapeHtml(m.display)}" ${sel?'selected':''}>${escapeHtml(m.display)}</option>`;
    }
    html += `</optgroup>`;
  }
  // Preserve a custom/unknown id (e.g. a model from an older config) so it
  // doesn't silently disappear when the user opens settings.
  if (selectedId && !foundSelected) {
    html = `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedId)} (custom)</option>` + html;
  }
  return html;
}

function bindEvents() {
  $('#new-conversation').addEventListener('click', () => {
    state.currentId = null;
    state.conversation = null;
    render();
  });
  $('#open-about').addEventListener('click', async () => {
    $('#about-drawer').hidden = false;
    // Fetch version lazily so the drawer opens instantly even if the server is slow.
    try {
      const info = await api('GET', '/api/about');
      $('#about-version').textContent = info.version || '—';
    } catch {
      $('#about-version').textContent = '—';
    }
  });
  $('#close-about').addEventListener('click', () => { $('#about-drawer').hidden = true; });
  $('#open-settings').addEventListener('click', () => { $('#settings-drawer').hidden = false; renderSettings(); });
  $('#close-settings').addEventListener('click', () => { $('#settings-drawer').hidden = true; });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = JSON.parse(JSON.stringify(state.config));
    cfg.chairman = $('#settings-chairman').value;
    cfg.min_responses_to_proceed = Number($('#settings-min').value);
    cfg.councillor_timeout_seconds = Number($('#settings-timeout').value);
    // Reassemble councillors from the new dropdown-driven row UI.
    $$('#settings-councillors .councillor-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const backendSel = $('select[data-k="backend"]', row);
      const modelSel = $('select[data-k="model"]', row);
      const displayInp = $('input[data-k="display"]', row);
      const c = cfg.council[i];
      c.backend = backendSel.value;
      c.id = modelSel.value;
      const chosen = modelSel.selectedOptions[0];
      if (chosen && chosen.dataset.vendor) c.vendor = chosen.dataset.vendor;
      c.display = displayInp.value;
    });
    try {
      await api('PUT', '/api/config', cfg);
      $('#settings-status').textContent = 'Saved. Takes effect on next question.';
    } catch (err) {
      $('#settings-status').textContent = err.message;
    }
  });
  $('#settings-councillors').addEventListener('change', (e) => {
    // When backend changes, re-render the model dropdown for that row with
    // the new backend's catalog.
    if (e.target.dataset.k === 'backend') {
      const i = Number(e.target.dataset.i);
      const newBackend = e.target.value;
      const firstModel = (state.models[newBackend] || [])[0];
      if (firstModel) {
        state.config.council[i].backend = newBackend;
        state.config.council[i].id = firstModel.id;
        state.config.council[i].vendor = firstModel.vendor;
        state.config.council[i].display = firstModel.display;
        renderSettings();
      }
    } else if (e.target.dataset.k === 'model') {
      // Auto-fill display name from the chosen model unless the user already
      // edited it to something distinct.
      const i = Number(e.target.dataset.i);
      const chosen = e.target.selectedOptions[0];
      if (chosen) {
        state.config.council[i].id = chosen.value;
        if (chosen.dataset.vendor) state.config.council[i].vendor = chosen.dataset.vendor;
        if (chosen.dataset.display) {
          const row = e.target.closest('.councillor-row');
          const displayInp = $('input[data-k="display"]', row);
          if (displayInp) displayInp.value = chosen.dataset.display;
        }
      }
    }
  });
  $('#settings-councillors').addEventListener('click', (e) => {
    const rm = e.target.dataset.remove;
    if (rm !== undefined) {
      state.config.council.splice(Number(rm), 1);
      renderSettings();
    }
    if (e.target.id === 'add-councillor') {
      // Pre-fill with the first available task-backend model so the new row
      // is functional out of the box.
      const seed = (state.models && state.models.task && state.models.task[0])
                || { id: 'claude-sonnet-4.6', vendor: 'Anthropic', display: 'Claude Sonnet 4.6' };
      state.config.council.push({ id: seed.id, vendor: seed.vendor, display: seed.display, backend: 'task' });
      renderSettings();
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Sanitised markdown rendering. Always use this for untrusted strings
// (councillor responses, ranker raw text, chairman synthesis, anything
// reaching innerHTML). marked v12 does NOT sanitise HTML on its own.
function safeMd(text) {
  if (!text) return '';
  const rendered = (typeof marked !== 'undefined') ? marked.parse(String(text)) : escapeHtml(text);
  if (typeof DOMPurify === 'undefined') return escapeHtml(text);
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'style']
  });
}

init().catch((e) => console.error(e));
