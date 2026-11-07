/* Fasta Status operator dashboard. Talks only to /admin/api (protected by Cloudflare Access). */
(() => {
  'use strict';
  const TZ = 'Africa/Nairobi';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = new Intl.DateTimeFormat('en-KE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const when = (ts) => (ts ? `${fmt.format(new Date(ts))} EAT` : '—');

  /** <input type=datetime-local> values are entered and shown in EAT (UTC+3). */
  const toLocal = (ts) => (ts ? new Date(ts + 3 * 3600_000).toISOString().slice(0, 16) : '');
  const fromLocal = (v) => (v ? Date.parse(`${v}:00+03:00`) : null);

  const STAGES = [['investigating', 'Investigating'], ['identified', 'Identified'], ['monitoring', 'Monitoring'], ['resolved', 'Resolved']];
  const IMPACTS = [['degraded', 'Degraded performance'], ['partial_outage', 'Partial outage'], ['major_outage', 'Major outage']];
  const CATS = [['new', 'New'], ['improved', 'Improved'], ['fixed', 'Fixed']];
  const AUD = [['everyone', 'Everyone'], ['customers', 'Customers'], ['sellers', 'Sellers'], ['riders', 'Delivery partners']];
  const RSTAGES = [['planned', 'Planned'], ['in_progress', 'In progress'], ['beta', 'In beta'], ['shipped', 'Shipped']];
  const TEMPLATES = {
    investigating: 'Some customers are unable to [what is broken]. [What still works] is available. We\'re investigating and will post another update by [time] EAT.',
    identified: 'We\'ve identified the cause: [plain-language cause]. We\'re [what the team is doing] to restore service. Next update by [time] EAT.',
    monitoring: 'A fix is in place and [flow] is working again. We\'re monitoring to confirm it stays stable.',
    resolved: 'This is resolved. Between [start] and [end] EAT, some customers could not [impact]. [Any action customers need to take, or "No action is needed."]',
  };

  let components = [];
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const compChecks = (name, selected = []) => `<div class="checkset">${components.map((c) =>
    `<label><input type="checkbox" name="${name}" value="${c.id}"${selected.includes(c.id) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>`;
  const checked = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const compName = (id) => components.find((c) => c.id === id)?.name || id;

  function flash(msg, ok = true) {
    const el = $('#flash');
    el.innerHTML = `<div class="${ok ? 'ok' : 'err'}">${esc(msg)}</div>`;
    setTimeout(() => { if (el.textContent === msg) el.innerHTML = ''; }, 6000);
  }

  async function api(path, method = 'GET', body) {
    const r = await fetch(`/admin/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fasta-status', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && path !== 'login') { showSignin(); throw new Error('Not signed in'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }
  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) flash(okMsg); await route(); } catch (e) { flash(e.message, false); }
  };

  // ------------------------------------------------------------------ Monitors
  const ms = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const pc = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  const ago = (ts) => { if (!ts) return '—'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : when(ts); };
  /** Tiny inline chart: bars = hourly average response, red = hours with failures. */
  function spark(hourly) {
    if (!hourly?.length) return '';
    const max = Math.max(500, ...hourly.map((h) => h.lat_avg || 0));
    return `<svg class="spark" viewBox="0 0 96 24" preserveAspectRatio="none" aria-hidden="true">${hourly.map((h, i) => {
      const fail = h.down > 0; const v = h.lat_avg || 0; const hh = h.total ? Math.max(2, (v / max) * 22) : 0;
      return `<rect x="${i * 4}" y="${24 - (fail && !v ? 22 : hh)}" width="3" height="${fail && !v ? 22 : hh}" fill="${fail ? 'var(--bad)' : 'var(--brand)'}" opacity="${h.total ? 1 : .2}"><title>${h.hour.slice(11)}:00 EAT · avg ${ms(h.lat_avg)} · max ${ms(h.lat_max)} · ${h.down} failed of ${h.total}</title></rect>`;
    }).join('')}</svg>`;
  }

  async function viewMonitors() {
    const o = await api('overview');
    components = o.components;
    const stale = !o.last_run_at || o.now - o.last_run_at > o.settings.staleMs;
    const failing = o.checks.filter((c) => c.state && c.state.state !== 'up');
    const rows = o.checks.map((c) => {
      const s = c.state;
      const st = s ? s.state : 'no data';
      const cls = st === 'down' ? 's-major_outage' : st === 'degraded' ? 's-degraded' : st === 'up' ? 's-operational' : 's-unavailable';
      return `<tr>
        <td><b>${esc(compName(c.component))}</b><br>${esc(c.name)}<br><span class="small muted">Public: “${esc(c.label)}”</span><br><span class="chip">${c.depth === 'deep' ? 'content/structure check' : 'availability check'}</span></td>
        <td><span class="pill ${cls}">${esc(st)}</span><br><span class="small muted">last run: ${esc(s?.last_outcome || '—')}${s?.last_kind && s.last_kind !== 'ok' ? ` (${esc(s.last_kind)})` : ''}</span><br><span class="small muted">${esc(ago(s?.last_result_at))}</span></td>
        <td>${esc(s?.last_reason || '—')}<br><span class="small muted">HTTP ${esc(s?.last_status ?? '—')} · ${esc(ms(s?.last_latency_ms))}</span>${s?.first_failure_at ? `<br><span class="small">first failure ${esc(when(s.first_failure_at))}</span>` : ''}${s?.down_since ? `<br><span class="small"><b>down since ${esc(when(s.down_since))}</b></span>` : ''}</td>
        <td>${spark(c.hourly)}<div class="small muted">avg ${esc(ms(c.avg_24h_ms))} · max ${esc(ms(c.max_24h_ms))}</div></td>
        <td class="small">24h <b>${esc(pc(c.uptime_24h))}</b><br>7d ${esc(pc(c.uptime_7d))}<br>30d ${esc(pc(c.uptime_30d))}</td>
        <td class="small">fail ${s?.fail_streak ?? 0} · ok ${s?.ok_streak ?? 0}</td>
        <td class="small"><code>${esc(c.method)} ${esc(c.url)}</code><br>expects HTTP ${esc(c.expect.join('/'))} · slow &gt; ${esc(ms(c.slow_ms))}</td></tr>`;
    }).join('');
    const outageRows = (o.outages || []).map((x) => `<tr><td>${esc(when(x.started_at))}</td><td>${x.ended_at ? esc(when(x.ended_at)) : '<b>ongoing</b>'}</td>
      <td>${esc(Math.max(1, Math.round(((x.ended_at || o.now) - x.started_at) / 60000)))} min</td><td>${esc(compName(x.component))}</td><td>${esc(x.check_id)}</td><td>${esc(x.severity)} · ${esc(x.kind)}</td></tr>`).join('');
    $('#app').innerHTML = `
      <h1 class="page">Monitors</h1>
      <div class="card panel">
        <p style="margin:0">Last run: <b>${esc(when(o.last_run_at))}</b> (${esc(ago(o.last_run_at))}) ${stale ? '<span class="pill s-major_outage">STALE: public page shows "Status unavailable"</span>' : ''}</p>
        <p style="margin:6px 0 0"><b>${o.checks.length}</b> live checks · <b>${failing.length}</b> not passing · <b>${o.pending.length}</b> waiting on test setup</p>
        <p class="small muted" style="margin:6px 0 0">Every minute · timeout ${o.settings.timeoutMs / 1000}s · outage after ${o.settings.failThreshold} failures in a row · recovery after ${o.settings.recoverThreshold} successes · slow above ${ms(o.settings.slowMs)} · stale after ${o.settings.staleMs / 1000}s</p>
        <div class="btns"><button class="btn primary" id="runnow">Run checks now</button>
          <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin:0"><input type="checkbox" id="onlybad"> Show only checks that are not passing</label></div>
      </div>
      <h2 style="margin-top:20px">Live checks</h2>
      <p class="small muted">"Last result" shows the exact technical reason. It is private: the public page only shows a plain-language category such as "Not responding".</p>
      <div class="card tablewrap"><table id="cktable"><thead><tr><th>Check</th><th>State</th><th>Last result (private)</th><th>Response, 24h</th><th>Uptime</th><th>Streaks</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h2 style="margin-top:20px">Detected problem periods</h2>
      <div class="card tablewrap"><table><thead><tr><th>Started</th><th>Ended</th><th>Length</th><th>Service</th><th>Check</th><th>Type</th></tr></thead><tbody>
        ${outageRows || '<tr><td colspan="6">None yet.</td></tr>'}</tbody></table></div>
      <h2 style="margin-top:20px">Waiting on test setup</h2>
      <div class="card tablewrap"><table><thead><tr><th>Service</th><th>Check</th><th>What's needed</th></tr></thead><tbody>
        ${o.pending.map((p) => `<tr><td>${esc(compName(p.component))}</td><td>${esc(p.publicLabel)}</td><td>${esc(p.needs)}</td></tr>`).join('') || '<tr><td colspan="3">None, all checks are live.</td></tr>'}
      </tbody></table></div>
      <h2 style="margin-top:20px">Alert log</h2>
      <div class="card tablewrap"><table><thead><tr><th>Time</th><th>Check</th><th>Event</th><th>Reason</th><th>Alert sent</th></tr></thead><tbody>
        ${o.events.map((e) => `<tr><td>${esc(when(e.at))}</td><td>${esc(e.check_id)}</td><td>${esc(e.kind)}</td><td>${esc(e.reason)}</td><td>${e.alerted ? 'yes' : '<b>no channel / failed</b>'}</td></tr>`).join('') || '<tr><td colspan="5">No events yet.</td></tr>'}
      </tbody></table></div>`;
    $('#runnow').onclick = () => act(() => api('run-checks', 'POST', {}), 'Checks finished');
    $('#onlybad').onchange = (e) => {
      [...$('#cktable tbody').rows].forEach((r, i) => { r.hidden = e.target.checked && o.checks[i].state?.state === 'up'; });
    };
  }

  // ------------------------------------------------------------------ Incidents
  async function viewIncidents() {
    if (!components.length) components = (await api('overview')).components;
    const list = await api('incidents');
    const open = list.filter((i) => !i.resolved_at), closed = list.filter((i) => i.resolved_at);
    const card = (i) => `<div class="listitem">
      <b>${esc(i.title)}</b> <span class="chip">${esc(i.stage)}</span> <span class="chip">${esc(IMPACTS.find((x) => x[0] === i.impact)?.[1])}</span>
      <div class="small muted">${esc(i.components.map(compName).join(', '))} · started ${esc(when(i.started_at))}${i.resolved_at ? ` · resolved ${esc(when(i.resolved_at))}` : ''}${!i.resolved_at && i.next_update_at ? ` · <b>next update due ${esc(when(i.next_update_at))}</b>` : ''}</div>
      <details style="margin-top:6px"><summary class="small">Timeline (${i.updates.length})</summary>
        <ul class="small">${i.updates.map((u) => `<li><b>${esc(u.stage)}</b> ${esc(when(u.created_at))} by ${esc(u.created_by)}: ${esc(u.message)}</li>`).join('')}</ul></details>
      ${i.resolved_at ? '' : `<form class="upd" data-id="${i.id}" style="margin-top:8px">
        <div class="row"><div><label>Stage</label><select name="stage">${opts(STAGES, i.stage === 'investigating' ? 'identified' : i.stage === 'identified' ? 'monitoring' : 'resolved')}</select></div>
        <div><label>Impact</label><select name="impact">${opts(IMPACTS, i.impact)}</select></div>
        <div><label>Next update by <span class="hint">(EAT)</span></label><input type="datetime-local" name="next"></div></div>
        <label>Affected components</label>${compChecks('c', i.components)}
        <label>Public update <span class="tpl">template: ${STAGES.map(([k, l]) => `<button type="button" data-tpl="${k}">${l}</button>`).join('')}</span></label>
        <textarea name="message" required></textarea>
        <div class="btns"><button class="btn primary">Post update</button></div></form>`}
      <div class="btns"><button class="btn small danger" data-del="${i.id}">Delete (test incidents only)</button></div>
    </div>`;
    $('#app').innerHTML = `
      <h1 class="page">Incidents</h1>
      <div class="grid2">
        <form class="card" id="newinc">
          <h2>Open an incident</h2>
          <label>Title <span class="hint">customer-facing, e.g. "Checkout failing for some customers"</span></label><input type="text" name="title" required maxlength="160">
          <div class="row"><div><label>Impact</label><select name="impact">${opts(IMPACTS, 'partial_outage')}</select></div>
          <div><label>Next update by <span class="hint">(EAT)</span></label><input type="datetime-local" name="next" value="${toLocal(Date.now() + 30 * 60000)}"></div></div>
          <label>Affected components</label>${compChecks('c')}
          <label>First update (Investigating) <span class="tpl"><button type="button" data-tpl="investigating">Use template</button></span></label>
          <textarea name="message" required></textarea>
          <p class="small muted">Say what customers experience, what still works, and when the next update is due. No internal URLs, error traces or customer data.</p>
          <div class="btns"><button class="btn primary">Publish incident</button></div>
        </form>
        <div>
          <h2>Open (${open.length})</h2>
          <div class="card">${open.map(card).join('') || '<div class="empty">No open incidents.</div>'}</div>
          <h2 style="margin-top:16px">Resolved</h2>
          <div class="card">${closed.slice(0, 30).map(card).join('') || '<div class="empty">None yet.</div>'}</div>
        </div>
      </div>`;
    const nf = $('#newinc');
    nf.onsubmit = (e) => { e.preventDefault(); act(() => api('incidents', 'POST', {
      title: nf.title.value, impact: nf.impact.value, components: checked(nf, 'c'), stage: 'investigating',
      message: nf.message.value, next_update_at: fromLocal(nf.next.value),
    }), 'Incident published'); };
    document.querySelectorAll('form.upd').forEach((f) => {
      f.onsubmit = (e) => { e.preventDefault(); act(() => api(`incidents/${f.dataset.id}/updates`, 'POST', {
        stage: f.stage.value, impact: f.impact.value, components: checked(f, 'c'), message: f.message.value, next_update_at: fromLocal(f.next.value),
      }), f.stage.value === 'resolved' ? 'Incident resolved' : 'Update posted'); };
    });
    document.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => {
      if (confirm('Delete this incident permanently? Only do this for test incidents.')) act(() => api(`incidents/${b.dataset.del}`, 'DELETE'), 'Deleted');
    }; });
  }

  // ------------------------------------------------------------------ Generic editor (maintenance, changelog, upcoming)
  async function viewEditor(cfg) {
    if (!components.length) components = (await api('overview')).components;
    const list = await api(cfg.path);
    const editId = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('edit')) || null;
    const item = editId ? list.find((x) => x.id === editId) : null;
    $('#app').innerHTML = `
      <h1 class="page">${esc(cfg.title)}</h1>
      <div class="grid2">
        <form class="card" id="ed"><h2>${item ? 'Edit' : 'Add'} ${esc(cfg.noun)}</h2>${cfg.form(item)}
          <div class="btns"><button class="btn primary">${item ? 'Save changes' : 'Publish'}</button>${item ? `<button type="button" class="btn" id="cancel">Cancel edit</button>` : ''}</div></form>
        <div class="card">${list.map((x) => `<div class="listitem">${cfg.row(x)}
          <div class="btns"><button class="btn small" data-edit="${x.id}">Edit</button>${cfg.extra ? cfg.extra(x) : ''}<button class="btn small danger" data-rm="${x.id}">Delete</button></div></div>`).join('') || '<div class="empty">Nothing yet.</div>'}</div>
      </div>`;
    const f = $('#ed');
    f.onsubmit = (e) => { e.preventDefault(); act(async () => {
      await api(item ? `${cfg.path}/${item.id}` : cfg.path, item ? 'PATCH' : 'POST', cfg.read(f));
      location.hash = cfg.hash;
    }, 'Saved'); };
    if ($('#cancel')) $('#cancel').onclick = () => { location.hash = cfg.hash; };
    document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => { location.hash = `${cfg.hash}?edit=${b.dataset.edit}`; }; });
    document.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => {
      if (confirm(`Delete this ${cfg.noun}?`)) act(() => api(`${cfg.path}/${b.dataset.rm}`, 'DELETE'), 'Deleted');
    }; });
    document.querySelectorAll('[data-patch]').forEach((b) => { b.onclick = () => act(() => api(`${cfg.path}/${b.dataset.id}`, 'PATCH', JSON.parse(b.dataset.patch)), 'Updated'); });
  }

  const MAINT = {
    path: 'maintenance', hash: '#maintenance', title: 'Scheduled maintenance', noun: 'maintenance window',
    form: (m) => `
      <label>Title</label><input type="text" name="title" required maxlength="160" value="${esc(m?.title)}" placeholder="Payment provider upgrade">
      <div class="row"><div><label>Starts <span class="hint">(EAT)</span></label><input type="datetime-local" name="starts" required value="${toLocal(m?.starts_at)}"></div>
      <div><label>Ends <span class="hint">(EAT)</span></label><input type="datetime-local" name="ends" required value="${toLocal(m?.ends_at)}"></div></div>
      <label>Affected components</label>${compChecks('c', m?.components || [])}
      <label>Expected customer impact</label><textarea name="message" required placeholder="Card payments may be unavailable for up to 20 minutes. M-Pesa and browsing are not affected.">${esc(m?.message)}</textarea>`,
    read: (f) => ({ title: f.title.value, starts_at: fromLocal(f.starts.value), ends_at: fromLocal(f.ends.value), components: checked(f, 'c'), message: f.message.value }),
    row: (m) => `<b>${esc(m.title)}</b> ${m.cancelled ? '<span class="chip">cancelled</span>' : ''}<div class="small muted">${esc(when(m.starts_at))} → ${esc(when(m.ends_at))} · ${esc(m.components.map(compName).join(', '))}</div><div class="small">${esc(m.message)}</div>`,
    extra: (m) => `<button class="btn small" data-id="${m.id}" data-patch='${JSON.stringify({ cancelled: !m.cancelled })}'>${m.cancelled ? 'Restore' : 'Cancel window'}</button>`,
  };
  const CHANGELOG = {
    path: 'changelog', hash: '#changelog', title: 'Changelog', noun: 'changelog entry',
    form: (e) => `
      <label>Title</label><input type="text" name="title" required maxlength="160" value="${esc(e?.title)}" placeholder="Track your rider live on the map">
      <div class="row"><div><label>Type</label><select name="category">${opts(CATS, e?.category || 'new')}</select></div>
      <div><label>Audience</label><select name="audience">${opts(AUD, e?.audience || 'everyone')}</select></div>
      <div><label>Publish date <span class="hint">(EAT, future = scheduled)</span></label><input type="datetime-local" name="published" value="${toLocal(e?.published_at ?? Date.now())}"></div></div>
      <label>Description</label><textarea name="body" required>${esc(e?.body)}</textarea>
      <label style="font-weight:400"><input type="checkbox" name="draft"${e?.draft ? ' checked' : ''}> Save as draft (hidden from the public page)</label>`,
    read: (f) => ({ title: f.title.value, category: f.category.value, audience: f.audience.value, published_at: fromLocal(f.published.value), body: f.body.value, draft: f.draft.checked }),
    row: (e) => `<span class="chip">${esc(e.category)}</span> <b>${esc(e.title)}</b> ${e.draft ? '<span class="chip">draft</span>' : ''}${e.published_at > Date.now() ? '<span class="chip">scheduled</span>' : ''}<div class="small muted">${esc(when(e.published_at))} · ${esc(e.audience)}</div>`,
  };
  const ROADMAP = {
    path: 'roadmap', hash: '#upcoming', title: 'Upcoming features', noun: 'feature',
    form: (r) => `
      <label>Title</label><input type="text" name="title" required maxlength="160" value="${esc(r?.title)}" placeholder="Scheduled deliveries">
      <div class="row"><div><label>Stage</label><select name="stage">${opts(RSTAGES, r?.stage || 'planned')}</select></div>
      <div><label>Audience</label><select name="audience">${opts(AUD, r?.audience || 'everyone')}</select></div>
      <div><label>Timing <span class="hint">(optional, e.g. "Early 2027")</span></label><input type="text" name="eta" maxlength="60" value="${esc(r?.eta_label)}"></div>
      <div><label>Order</label><input type="number" name="sort" value="${esc(r?.sort_order ?? 0)}"></div></div>
      <label>Description</label><textarea name="description" required>${esc(r?.description)}</textarea>
      <label style="font-weight:400"><input type="checkbox" name="hidden"${r?.hidden ? ' checked' : ''}> Hide from the public page</label>`,
    read: (f) => ({ title: f.title.value, stage: f.stage.value, audience: f.audience.value, eta_label: f.eta.value, sort_order: Number(f.sort.value), description: f.description.value, hidden: f.hidden.checked }),
    row: (r) => `<span class="chip">${esc(r.stage)}</span> <b>${esc(r.title)}</b> ${r.hidden ? '<span class="chip">hidden</span>' : ''}<div class="small muted">${esc(r.eta_label || 'no timing')} · ${esc(r.audience)} · order ${esc(r.sort_order)}</div>`,
  };

  // Template buttons fill the nearest textarea.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]');
    if (!b) return;
    const ta = b.closest('form').querySelector('textarea[name=message]');
    ta.value = TEMPLATES[b.dataset.tpl];
    const sel = b.closest('form').querySelector('select[name=stage]');
    if (sel) sel.value = b.dataset.tpl;
    ta.focus();
  });

  async function route() {
    const view = (location.hash.slice(1).split('?')[0]) || 'monitors';
    document.querySelectorAll('[data-view]').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    try {
      if (view === 'incidents') await viewIncidents();
      else if (view === 'maintenance') await viewEditor(MAINT);
      else if (view === 'changelog') await viewEditor(CHANGELOG);
      else if (view === 'upcoming') await viewEditor(ROADMAP);
      else await viewMonitors();
    } catch (e) { if (e.message !== 'Not signed in') flash(e.message, false); }
  }

  function showSignin() {
    $('#signin').hidden = false;
    $('#app').innerHTML = '';
    $('#who').textContent = '';
    $('#logout').hidden = true;
    setTimeout(() => $('#si-email').focus(), 0);
  }
  async function start() {
    const me = await api('me');
    $('#signin').hidden = true;
    $('#who').textContent = me.email;
    $('#logout').hidden = me.via !== 'password';
    route();
  }
  $('#signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#si-err').textContent = '';
    try {
      await api('login', 'POST', { email: $('#si-email').value, password: $('#si-pass').value });
      $('#si-pass').value = '';
      await start();
    } catch (err) { $('#si-err').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => {
    try { await api('logout', 'POST', {}); } catch {}
    showSignin();
  });

  window.addEventListener('hashchange', () => { if ($('#signin').hidden) route(); });
  start().catch(() => {});
})();
