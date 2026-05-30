// Module-level state, render-on-event.
const state = {
  config: null,
  conversations: [],   // each item has { id, title, turns:[{id,question,created_at}] }
  currentTurnId: null, // the single turn currently shown in the canvas
  currentCid: null,    // the conversation that contains currentTurnId
  conversation: null,  // full data for currentCid
  activeStages: {},    // turn_id -> stage number selected by user
  csrfToken: null,
  models: null
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
    if (msg.type === 'conversation-created') {
      // A brand-new conversation just started. Refresh the sidebar AND
      // auto-switch to it so the user immediately sees the stage-1 skeletons
      // (otherwise they sit on a stale loaded conversation thinking nothing
      // is happening). The new conv has exactly one turn at this point.
      state.conversations = await api('GET', '/api/conversations');
      const conv = state.conversations.find((c) => c.id === msg.conversation_id);
      const firstTurn = conv && conv.turns && conv.turns[0];
      if (firstTurn) {
        await selectTurn(msg.conversation_id, firstTurn.id);
      } else {
        renderSidebar();
      }
      return;
    }
    if (msg.type === 'turn-update') {
      const knownTids = new Set();
      for (const c of state.conversations) for (const t of (c.turns || [])) knownTids.add(t.id);

      state.conversations = await api('GET', '/api/conversations');

      // If this turn id is new to us (e.g. a follow-up just got created on a
      // conversation we already know about), auto-focus it.
      if (!knownTids.has(msg.turn_id)) {
        await selectTurn(msg.conversation_id, msg.turn_id);
        return;
      }
      if (state.currentCid === msg.conversation_id) {
        state.conversation = await api('GET', `/api/conversations/${msg.conversation_id}`);
        render();
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
  const health = await api('GET', '/api/health');
  state.csrfToken = health && health.csrf_token;
  try { state.models = await api('GET', '/api/models'); } catch { state.models = { task: [], 'github-models': [] }; }
  state.config = await api('GET', '/api/config');
  state.conversations = await api('GET', '/api/conversations');
  // Auto-select the newest turn across all conversations on first load.
  const newest = newestTurn(state.conversations);
  if (newest) await selectTurn(newest.cid, newest.tid);
  render();
  connectWs();
  bindEvents();
}

function newestTurn(conversations) {
  let best = null;
  for (const c of conversations) {
    for (const t of (c.turns || [])) {
      if (!best || (t.created_at && t.created_at > best.created_at)) {
        best = { cid: c.id, tid: t.id, created_at: t.created_at };
      }
    }
  }
  return best;
}

async function selectTurn(cid, tid) {
  state.currentCid = cid;
  state.currentTurnId = tid;
  state.activeStages = {};
  state.conversation = await api('GET', `/api/conversations/${cid}`);
  render();
}

// ---- Render ----------------------------------------------------------------
function render() {
  renderSidebar();
  if (!state.conversation || !state.currentTurnId) {
    $('#empty').hidden = false;
    $('#conversation').hidden = true;
    return;
  }
  const turn = state.conversation.turns.find((t) => t.id === state.currentTurnId);
  if (!turn) {
    $('#empty').hidden = false;
    $('#conversation').hidden = true;
    return;
  }
  $('#empty').hidden = true;
  $('#conversation').hidden = false;

  $('#conv-question').textContent = turn.question || '';
  $('#conv-meta').innerHTML = metaHtml(turn);
  // Mode pill in the header — hidden for general mode (the default) so
  // there's no noise when nothing special is going on.
  const pill = $('#conv-mode-pill');
  const mode = (state.conversation && state.conversation.mode) || 'general';
  if (mode && mode !== 'general') {
    pill.hidden = false;
    pill.className = `mode-pill mode-${mode}`;
    pill.textContent = mode;
  } else {
    pill.hidden = true;
  }

  // Each sidebar entry shows ONE question. Render only that turn's stages —
  // never stack multiple turns in the canvas.
  $('#stage-rail').innerHTML = stageRailHtml(turn);
  $('#stage-content').innerHTML = stageContentHtml(turn);

  bindStageClicks(turn, $('#stage-rail'), $('#stage-content'));
  bindCardClicks();
}

function renderSidebar() {
  const entries = [];
  for (const c of state.conversations) {
    for (const t of (c.turns || [])) {
      entries.push({
        cid: c.id,
        tid: t.id,
        question: t.question || c.title,
        created_at: t.created_at || c.created_at,
        mode: c.mode || 'general'
      });
    }
  }
  entries.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));

  const html = entries.map((e) => {
    const pill = (e.mode && e.mode !== 'general')
      ? `<span class="mode-pill mode-${escapeHtml(e.mode)}">${escapeHtml(e.mode)}</span>`
      : '';
    return `
      <button class="item ${e.tid === state.currentTurnId ? 'active' : ''}" data-cid="${e.cid}" data-tid="${e.tid}" title="${escapeHtml(e.question)}">
        <span class="title-row">
          ${pill}
          <span class="title">${escapeHtml(e.question)}</span>
        </span>
        <span class="date">${e.created_at ? compactDate(e.created_at) : ''}</span>
      </button>`;
  }).join('');
  $('#history').innerHTML = html || '<div class="muted" style="padding:8px">No questions yet.</div>';
  $$('#history .item').forEach((el) =>
    el.addEventListener('click', () => selectTurn(el.dataset.cid, el.dataset.tid))
  );
}

// Short, single-line date: "2m ago" / "3h ago" / "Mon 14:32" / "May 28".
// Keeps the sidebar row narrow so the mode pill always fits next to it.
function compactDate(iso) {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 24 * 3_600_000) {
    return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function metaHtml(turn) {
  // Prefer the conversation's snapshotted lineup (mode-resolved at init
  // time) over the global config, so the meta line is always honest about
  // who actually answered.
  const conv = state.conversation || {};
  const council = conv.council || state.config?.council || [];
  const chairman = conv.chairman || state.config?.chairman || '';
  const live = turn.councillors.filter((c) => c.status === 'ok').length;
  return `<span>${live}/${turn.councillors.length || council.length} councillors</span>
          <span>·</span>
          <span>Chairman · ${escapeHtml(chairman)}</span>`;
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

function bindStageClicks(turn, railEl, contentEl) {
  // For the single-turn view we get rail/content elements directly. For the
  // old multi-turn code path they'd be looked up by data attribute — keep
  // that fallback so external callers still work.
  railEl = railEl || document.querySelector(`[data-rail][data-turn="${turn.id}"]`);
  contentEl = contentEl || document.querySelector(`[data-content][data-turn="${turn.id}"]`);
  if (!railEl) return;
  railEl.querySelectorAll('.stage').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeStages[turn.id] = Number(el.dataset.stage);
      railEl.innerHTML = stageRailHtml(turn);
      contentEl.innerHTML = stageContentHtml(turn);
      bindStageClicks(turn, railEl, contentEl);
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
  // Prefer the snapshot on the conversation — different conversations may
  // have used different mode-pack lineups.
  const knownCouncil = (state.conversation && state.conversation.council)
                    || state.config?.council
                    || [];
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
  if (c.status === 'ok') {
    return `
      <div class="councillor" data-id="${escapeHtml(c.id)}">
        <div class="councillor-head">
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
  const council = (state.conversation && state.conversation.council) || state.config?.council || [];
  // Resolve a "Response A"-style label to the real councillor it points at,
  // using the turn's anonymisation map. Falls back to the raw label when the
  // map isn't populated yet (early in stage 2) so we never render undefined.
  const resolve = (label) => {
    const cid = turn.label_map && turn.label_map[label];
    if (!cid) return { id: null, label, meta: { vendor: 'Other', display: label } };
    const meta = council.find((c) => c.id === cid) || { vendor: 'Other', display: cid };
    return { id: cid, label, meta };
  };
  // Build a councillor-keyed view so the cards stay in council order with
  // skeletons for ballots still in flight.
  const byRanker = new Map(turn.rankings.map((r) => [r.ranker, r]));
  const rows = council.length
    ? council.map((c) => byRanker.get(c.id) || { ranker: c.id, _pending: true })
    : turn.rankings;

  const rankerNodes = rows.map((r) => {
    const meta = council.find((c) => c.id === r.ranker) || { vendor: 'Other', display: r.ranker };
    if (r._pending) {
      return `
        <div class="councillor">
          <div class="councillor-head">
            <div class="name-block">
              <div class="councillor-name">${escapeHtml(meta.display || r.ranker)}'s ballot</div>
              <div class="vendor-tag">${escapeHtml(r.ranker)}</div>
            </div>
          </div>
          <div class="thinking-label"><span class="pulse"></span>RANKING</div>
          <div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
        </div>`;
    }
    const parsedChips = (r.parsed && r.parsed.length)
      ? r.parsed.map((label, i) => {
          const { meta: rm } = resolve(label);
          return `<span class="ballot-chip"><span class="ballot-chip-rank">${i+1}</span><span class="ballot-chip-name">${escapeHtml(rm.display)}</span></span>`;
        }).join('<span class="ballot-arrow">›</span>')
      : `<span class="muted">No parseable ranking in this ballot.</span>`;
    return `
      <div class="councillor">
        <div class="councillor-head">
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || r.ranker)}'s ballot</div>
            <div class="vendor-tag">${escapeHtml(meta.vendor.toLowerCase())} · ${escapeHtml(r.ranker)}</div>
          </div>
          <span class="check">✓</span>
        </div>
        <div class="ballot-chips">${parsedChips}</div>
        <div class="response">${safeMd(r.raw || '')}</div>
        <div class="expand-row" data-expand>Read full rationale →</div>
      </div>`;
  }).join('');

  // Aggregate table — model column shows just the name, no avatar.
  const agg = turn.aggregate?.length ? `
    <div class="aggregate"><table>
      <thead><tr><th>Rank</th><th>Model</th><th>Avg position</th><th>Votes</th></tr></thead>
      <tbody>${turn.aggregate.map((a, i) => {
        const meta = council.find((c) => c.id === a.model) || { vendor: 'Other', display: a.model };
        return `<tr>
          <td class="num">${i+1}</td>
          <td>${escapeHtml(meta.display || a.model)}</td>
          <td class="num">${a.avg.toFixed(2)}</td>
          <td class="num">${a.votes}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : '';

  return `<div class="councillors">${rankerNodes}</div>${agg}`;
}

function stage3Html(turn) {
  if (!turn.synthesis) {
    // Skeleton: matches the shape of the eventual synthesis card so the
    // layout doesn't jump when the chairman's response lands.
    return `
      <div class="synthesis synthesis-pending">
        <div class="synthesis-label"><span>Chairman</span> <span class="muted">· ${escapeHtml((state.conversation && state.conversation.chairman) || state.config?.chairman || '…')}</span></div>
        <div class="thinking-label"><span class="pulse"></span>SYNTHESISING</div>
        <div class="synthesis-skeleton">
          <div class="skeleton-line" style="width:96%"></div>
          <div class="skeleton-line" style="width:88%"></div>
          <div class="skeleton-line" style="width:92%"></div>
          <div class="skeleton-line" style="width:76%"></div>
          <div class="skeleton-line" style="width:84%"></div>
          <div class="skeleton-line" style="width:60%"></div>
        </div>
      </div>`;
  }
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
      const turnId = state.currentTurnId;
      await api('POST', '/api/events', {
        type: 'retry-councillor',
        conversation_id: state.currentCid,
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
  function closeDrawers() {
    $('#about-drawer').hidden = true;
    $('#settings-drawer').hidden = true;
  }
  $('#new-conversation').addEventListener('click', () => {
    state.currentCid = null;
    state.currentTurnId = null;
    state.conversation = null;
    render();
  });
  $('#open-about').addEventListener('click', async () => {
    closeDrawers();
    $('#about-drawer').hidden = false;
    try {
      const info = await api('GET', '/api/about');
      $('#about-version').textContent = info.version || '—';
    } catch {
      $('#about-version').textContent = '—';
    }
  });
  $('#close-about').addEventListener('click', () => { $('#about-drawer').hidden = true; });
  $('#open-settings').addEventListener('click', () => {
    closeDrawers();
    $('#settings-drawer').hidden = false;
    renderSettings();
  });
  $('#close-settings').addEventListener('click', () => { $('#settings-drawer').hidden = true; });
  // ESC closes any open drawer.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });
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

