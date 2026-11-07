/* Fasta Status public page. No framework, no third-party scripts. */
(() => {
  'use strict';
  const TZ = 'Africa/Nairobi';
  const CACHE_KEY = 'fasta-status:last';
  const REFRESH_MS = 60_000;

  const STATUS = {
    operational:    { label: 'Operational', icon: 'check' },
    degraded:       { label: 'Degraded performance', icon: 'minus' },
    partial_outage: { label: 'Partial outage', icon: 'alert' },
    major_outage:   { label: 'Major outage', icon: 'x' },
    maintenance:    { label: 'Scheduled maintenance', icon: 'wrench' },
    unavailable:    { label: 'Status unavailable', icon: 'question' },
    unmonitored:    { label: 'No known issues', icon: 'dot' },
  };
  const OVERALL_ICON = { operational: 'check', degraded: 'minus', disruption: 'x', maintenance: 'wrench', unavailable: 'question', partly_unavailable: 'question' };
  const IMPACT = { degraded: 'Degraded performance', partial_outage: 'Partial outage', major_outage: 'Major outage' };
  const STAGE = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
  const CATEGORY = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
  const AUDIENCE = { everyone: 'Everyone', customers: 'Customers', sellers: 'Sellers', riders: 'Delivery partners' };
  const LANES = [['in_progress', 'In progress'], ['beta', 'In beta'], ['planned', 'Planned'], ['shipped', 'Recently shipped']];

  const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    minus: '<path d="M6 12h12"/>',
    alert: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
    x: '<path d="M7 7l10 10M17 7L7 17"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L5 16l3 3 4.2-4.2a4 4 0 0 0 5.3-5.3l-2.3 2.3-2.4-.6-.6-2.4z"/>',
    question: '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17h.01"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  };
  const icon = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);

  const fmtTime = new Intl.DateTimeFormat('en-KE', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  const fmtDate = new Intl.DateTimeFormat('en-KE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDay = new Intl.DateTimeFormat('en-KE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  const time = (ts) => fmtTime.format(new Date(ts)).replace('am', 'a.m.').replace('pm', 'p.m.').replace('AM', 'a.m.').replace('PM', 'p.m.');
  const when = (ts) => `${fmtDate.format(new Date(ts))}, ${time(ts)} EAT`;
  const dayLabel = (d) => fmtDay.format(new Date(`${d}T12:00:00+03:00`));
  const ago = (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return when(ts);
  };
  const duration = (a, b) => {
    const m = Math.max(1, Math.round((b - a) / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  };

  const pill = (status, text) => {
    const s = STATUS[status] || STATUS.unavailable;
    return `<span class="pill s-${esc(status)}">${icon(s.icon)}<span>${esc(text || s.label)}</span></span>`;
  };

  let data = null;
  const compName = (id) => data?.components.find((c) => c.id === id)?.name || id;

  // ---------------------------------------------------------------- views
  function setView() {
    const v = (location.hash || '#status').slice(1);
    const view = ['status', 'changelog', 'upcoming'].includes(v) ? v : 'status';
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== view));
    document.querySelectorAll('[data-view]').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = view === 'status' ? 'Fasta Status' : view === 'changelog' ? 'Changelog · Fasta Status' : 'Upcoming features · Fasta Status';
  }

  function incidentCard(i, { full = false } = {}) {
    const latest = i.updates[0];
    const st = i.resolved_at ? 'operational' : i.impact;
    const comps = i.components.map((c) => `<span class="chip">${esc(compName(c))}</span>`).join(' ');
    const body = full
      ? `<ol class="timeline">${i.updates.map((u) => `<li><span class="stage">${esc(STAGE[u.stage])}</span> <span class="muted small">— ${esc(when(u.created_at))}</span><p class="msg">${esc(u.message)}</p></li>`).join('')}</ol>`
      : latest ? `<div class="update"><span class="stage">${esc(STAGE[latest.stage])}</span> <span class="muted small">— ${esc(when(latest.created_at))}</span><p class="msg">${esc(latest.message)}</p></div>` : '';
    const next = !i.resolved_at && i.next_update_at
      ? `<p class="next">Next update by ${esc(time(i.next_update_at))} EAT${i.next_update_at < Date.now() ? ' (update due)' : ''}</p>` : '';
    const resolved = i.resolved_at ? `<span>Resolved ${esc(when(i.resolved_at))} · lasted ${esc(duration(i.started_at, i.resolved_at))}</span>` : '';
    return `<article class="card incident s-${esc(st)}">
      <h3>${full ? esc(i.title) : `<a href="/incident.html?id=${encodeURIComponent(i.id)}">${esc(i.title)}</a>`}</h3>
      <div class="meta">${i.resolved_at ? pill('operational', 'Resolved') : pill(i.impact, IMPACT[i.impact])}<span>Started ${esc(when(i.started_at))}</span>${resolved}</div>
      <div class="meta">Affects: ${comps || '—'}</div>
      ${body}${next}
    </article>`;
  }

  function maintCard(m, now) {
    const live = m.starts_at <= now && m.ends_at > now;
    const done = m.ends_at <= now;
    return `<article class="incident s-maintenance" style="border-left-width:5px">
      <h3>${esc(m.title)}</h3>
      <div class="meta">${pill('maintenance', live ? 'In progress' : done ? 'Completed' : 'Scheduled')}
        <span>${esc(when(m.starts_at))} – ${esc(m.ends_at - m.starts_at < 86400000 ? time(m.ends_at) + ' EAT' : when(m.ends_at))}</span></div>
      <div class="meta">Affects: ${m.components.map((c) => `<span class="chip">${esc(compName(c))}</span>`).join(' ')}</div>
      <p class="msg update">${esc(m.message)}</p>
    </article>`;
  }

  function bar(h) {
    const mark = h.incident ? ' has-inc' : '';
    if (h.uptime === null) return `<span class="nodata${mark}" title="${esc(dayLabel(h.day))}: no data${h.incident ? ' · incident reported' : ''}"></span>`;
    const u = h.uptime;
    const cls = u >= 99.9 ? 'u-full' : u >= 99 ? 'u-high' : u >= 95 ? 'u-mid' : u >= 90 ? 'u-low' : 'u-bad';
    const bits = [`${u}% available`];
    if (h.down_minutes) bits.push(`about ${h.down_minutes} min failing`);
    if (h.degraded_minutes) bits.push(`about ${h.degraded_minutes} min slow`);
    if (h.avg_ms) bits.push(`average response ${fmtMs(h.avg_ms)}`);
    if (h.incident) bits.push('incident reported');
    return `<span class="${cls}${mark}" title="${esc(dayLabel(h.day))}: ${esc(bits.join(' · '))}"></span>`;
  }

  const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`);
  const fmtPct = (p) => (p === null || p === undefined ? '—' : `${p >= 99.995 ? '100' : p.toFixed(2)}%`);
  const hourLabel = (h) => { const n = Number(h.slice(11, 13)); return `${n % 12 || 12}${n < 12 ? 'am' : 'pm'}`; };
  const CHECK_ICON = { operational: 'check', degraded: 'minus', down: 'x', unknown: 'question', unavailable: 'question' };
  const CHECK_STATUS = { operational: 'operational', degraded: 'degraded', down: 'major_outage', unknown: 'unavailable', unavailable: 'unavailable' };
  const CHECK_TEXT = { operational: 'Working', degraded: 'Slow', down: 'Failing', unknown: 'Waiting for first result', unavailable: 'No recent data' };

  /** 24-hour response-time chart: one bar per hour (height = average response), red = hour with failures. */
  function chart(c) {
    const pts = c.response.hourly;
    if (!pts.length || pts.every((p) => p.avg_ms === null && p.uptime === null)) return '<p class="small muted">The response-time chart appears after the first checks.</p>';
    const max = Math.max(1000, ...pts.map((p) => p.max_ms || p.avg_ms || 0));
    const nice = max <= 1000 ? 1000 : max <= 2000 ? 2000 : max <= 5000 ? 5000 : max <= 10000 ? 10000 : Math.ceil(max / 10000) * 10000;
    const bars = pts.map((p, i) => {
      const next = pts[(i + 1) % pts.length];
      const tip = `${hourLabel(p.hour)}–${hourLabel(next.hour)} EAT: ${p.avg_ms === null ? (p.uptime === null ? 'no data' : 'no successful responses') : `average ${fmtMs(p.avg_ms)}, slowest ${fmtMs(p.max_ms)}`}${p.uptime !== null ? ` · ${fmtPct(p.uptime)} available` : ''}`;
      const fail = p.uptime !== null && p.uptime < 100;
      const h = p.avg_ms === null ? (fail ? 100 : 0) : Math.max(3, Math.round((p.avg_ms / nice) * 100));
      const cls = p.uptime === null ? 'hb none' : fail ? (p.avg_ms === null ? 'hb fail full' : 'hb fail') : 'hb';
      return `<span class="${cls}" title="${esc(tip)}"><i style="height:${h}%"></i></span>`;
    }).join('');
    return `<figure class="chart" aria-label="${esc(c.name)} average response time per hour, last 24 hours">
      <div class="hbars"><span class="ax ax-top">${esc(fmtMs(nice))}</span><span class="ax ax-mid">${esc(fmtMs(nice / 2))}</span>${bars}</div>
      <figcaption><span>24 hours ago</span><span><i class="lg-ok"></i>Avg. response per hour <i class="lg-fail"></i>Hour with failures</span><span>Now</span></figcaption></figure>`;
  }

  function checkRow(k) {
    const st = CHECK_STATUS[k.status];
    const problem = k.problem ? `<div class="ck-problem s-${st}">${esc(k.problem)}${k.since ? ` since ${esc(time(k.since))} EAT` : ''}</div>` : '';
    return `<li class="ck">
      <span class="ck-icon s-${st}" title="${esc(CHECK_TEXT[k.status])}">${icon(CHECK_ICON[k.status] || 'question', 14)}</span>
      <div class="ck-main"><div class="ck-label">${esc(k.label)} <span class="sr-only">— ${esc(CHECK_TEXT[k.status])}</span></div>
        <div class="ck-detail">${esc(k.detail)}${k.depth === 'basic' ? ' <span class="chip">availability only</span>' : ''}</div>${problem}</div>
      <dl class="ck-stats"><div><dt>Response</dt><dd>${esc(fmtMs(k.response_ms))}</dd></div><div><dt>24h</dt><dd>${esc(fmtPct(k.uptime_24h))}</dd></div><div><dt>Checked</dt><dd>${k.last_checked_at ? esc(ago(k.last_checked_at)) : '—'}</dd></div></dl>
    </li>`;
  }

  function componentCard(c) {
    const confirmed = c.last_confirmed ? `<p class="mon">Last confirmed: ${esc(STATUS[c.last_confirmed.status]?.label)} at ${esc(when(c.last_confirmed.at))}</p>` : '';
    const problems = c.checks.filter((k) => k.status === 'down' || k.status === 'degraded');
    const summary = c.monitoring === 'none'
      ? 'Updated by the Fasta team. Automated checks are coming soon.'
      : problems.length ? `${problems.length} of ${c.checks.length} checks ${problems.some((k) => k.status === 'down') ? 'failing' : 'slow'}: ${problems.map((k) => k.problem).filter((v, i, a) => a.indexOf(v) === i).join('; ').toLowerCase()}`
      : `${c.checks.length} automated check${c.checks.length === 1 ? '' : 's'} every minute${c.checks.every((k) => k.status === 'operational') ? ', all passing' : ''}`;
    const stats = c.monitoring === 'none' ? '' : `<dl class="stats">
        <div><dt>Uptime 24h</dt><dd>${esc(fmtPct(c.uptime.h24))}</dd></div>
        <div><dt>7 days</dt><dd>${esc(fmtPct(c.uptime.d7))}</dd></div>
        <div><dt>30 days</dt><dd>${esc(fmtPct(c.uptime.d30))}</dd></div>
        <div><dt>90 days</dt><dd>${esc(fmtPct(c.uptime.d90))}</dd></div>
        <div><dt>Response now</dt><dd>${esc(fmtMs(c.response.current_ms))}</dd></div>
        <div><dt>24h average</dt><dd>${esc(fmtMs(c.response.avg_24h_ms))}</dd></div>
      </dl>`;
    const hist = c.monitoring === 'none' ? '' : `
      <div class="bars" role="img" aria-label="${esc(c.name)} daily availability, last 90 days${c.uptime.d90 !== null ? `: ${c.uptime.d90}%` : ''}">${c.history.map(bar).join('')}</div>
      <div class="bars-legend"><span><span class="d90">90 days ago</span><span class="d30">30 days ago</span></span><span>${c.uptime.d90 !== null ? `${esc(fmtPct(c.uptime.d90))} uptime` : 'No data yet'}</span><span>Today</span></div>`;
    const list = [...c.checks.map(checkRow), ...c.pending_checks.map((p) => `<li class="ck pending"><span class="ck-icon s-unmonitored">${icon('dot', 14)}</span><div class="ck-main"><div class="ck-label">${esc(p)}</div><div class="ck-detail">Coming soon: needs test data set up first.</div></div></li>`)].join('');
    const openAttr = problems.length || c.status !== 'operational' && c.status !== 'unmonitored' ? ' open' : '';
    return `<article class="comp" id="svc-${esc(c.id)}">
      <div class="comp-head"><div><h3 class="comp-name">${esc(c.name)}</h3><div class="comp-desc">${esc(c.description)}</div></div>${pill(c.status)}</div>
      ${confirmed}
      <p class="mon">${esc(summary)}</p>
      ${hist}
      <details class="more"${openAttr}><summary>${c.monitoring === 'none' ? 'What we will check' : 'Details: checks, response times and uptime'}</summary>
        ${stats}
        ${c.monitoring === 'none' ? '' : chart(c)}
        <ul class="cklist">${list}</ul>
      </details>
    </article>`;
  }

  function renderDetections() {
    const list = (data.detections || []).slice(0, 25);
    $('detect-list').innerHTML = list.length ? `<div class="tablewrap"><table class="det"><thead><tr><th>Service</th><th>What happened</th><th>Started</th><th>Ended</th><th>Duration</th></tr></thead><tbody>${list.map((o) => `
      <tr><td>${esc(o.component_name)}<div class="small muted">${esc(o.check)}</div></td>
      <td><span class="pill s-${o.severity === 'down' ? 'major_outage' : 'degraded'}">${icon(o.severity === 'down' ? 'x' : 'minus', 14)}<span>${esc(o.problem)}</span></span></td>
      <td>${esc(when(o.started_at))}</td><td>${o.ended_at ? esc(when(o.ended_at)) : '<b>Ongoing</b>'}</td>
      <td>${esc(duration(o.started_at, o.ended_at || Date.now()))}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No problems detected by automated checks in the last 30 days.</div>';
  }

  function renderStatus(now) {
    const o = data.overall;
    const banner = $('banner');
    banner.className = `banner s-${o.status}`;
    banner.querySelector('.icon').innerHTML = icon(OVERALL_ICON[o.status] || 'question', 24);
    banner.querySelector('h1').textContent = o.text;
    $('updated').textContent = data.last_checked_at
      ? `Last checked ${ago(data.last_checked_at)} (${when(data.last_checked_at)})`
      : 'Waiting for the first monitoring results';
    const sm = data.summary;
    $('summary').innerHTML = sm ? `<span><b>${sm.operational}</b> of ${data.components.length} services fully operational</span><span><b>${sm.affected}</b> affected</span><span><b>${sm.monitored_checks}</b> automated checks every minute</span>${sm.planned_checks ? `<span><b>${sm.planned_checks}</b> more checks coming</span>` : ''}` : '';

    const note = $('stale-note');
    if (data._offline) {
      note.hidden = false;
      note.textContent = `We can't reach the status service right now. Showing the last confirmed results from ${when(data.generated_at)}.`;
    } else if (data.stale) {
      note.hidden = false;
      note.textContent = 'Monitoring results are delayed, so current status is unavailable. The last confirmed result for each service is shown.';
    } else note.hidden = true;

    $('active').hidden = data.active_incidents.length === 0;
    $('active-list').innerHTML = data.active_incidents.map((i) => incidentCard(i)).join('');

    const inProg = data.maintenance.in_progress;
    $('maint-now').hidden = inProg.length === 0;
    $('maint-now-list').innerHTML = inProg.length ? `<div class="card">${inProg.map((m) => maintCard(m, now)).join('')}</div>` : '';

    // Remember which "Details" panels the visitor opened, across the 60-second refresh.
    const openNow = new Set([...document.querySelectorAll('.comp details.more')].filter((d) => d.open).map((d) => d.closest('.comp').id));
    const hadRender = document.querySelector('.comp') !== null;
    const groups = [];
    for (const c of data.components) { let g = groups.find((x) => x.name === c.group); if (!g) groups.push(g = { name: c.group, items: [] }); g.items.push(c); }
    $('components').innerHTML = groups.map((g) => `<h3 class="grp">${esc(g.name || 'Services')}</h3><div class="card">${g.items.map(componentCard).join('')}</div>`).join('');
    if (hadRender) document.querySelectorAll('.comp details.more').forEach((d) => { d.open = openNow.has(d.closest('.comp').id); });

    renderDetections();

    const upcoming = data.maintenance.upcoming;
    $('maint-list').innerHTML = upcoming.length ? upcoming.map((m) => maintCard(m, now)).join('') : '<div class="empty">No maintenance scheduled.</div>';

    const past = data.past_incidents;
    $('past-list').innerHTML = past.length ? past.map((i) => incidentCard(i)).join('') : '<div class="card empty">No incidents in the last 90 days.</div>';
  }

  let clFilter = 'all';
  function renderChangelog() {
    const items = data.changelog.filter((e) => clFilter === 'all' || e.category === clFilter || e.audience === clFilter);
    $('cl-filters').innerHTML = [['all', 'All'], ['new', 'New'], ['improved', 'Improved'], ['fixed', 'Fixed'], ['customers', 'Customers'], ['sellers', 'Sellers'], ['riders', 'Delivery partners']]
      .map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${clFilter === k}">${l}</button>`).join('');
    $('changelog').innerHTML = items.length ? items.map((e) => `<article class="entry">
        <div class="meta" style="margin:0 0 4px"><span class="tag tag-${esc(e.category)}">${esc(CATEGORY[e.category] || e.category)}</span>${e.audience !== 'everyone' ? `<span class="tag tag-audience">${esc(AUDIENCE[e.audience])}</span>` : ''}<span>${esc(fmtDate.format(new Date(e.published_at)))}</span></div>
        <h3>${esc(e.title)}</h3><p class="body">${esc(e.body)}</p></article>`).join('')
      : '<div class="empty">No changelog entries yet.</div>';
  }

  function renderRoadmap() {
    const lanes = LANES.map(([k, label]) => {
      const items = data.roadmap.filter((r) => r.stage === k);
      if (!items.length) return '';
      return `<div class="card lane"><h3>${esc(label)}</h3><ul>${items.map((r) => `<li><div class="t">${esc(r.title)}</div>
        <div class="meta" style="margin-top:2px">${r.audience !== 'everyone' ? `<span class="tag tag-audience">${esc(AUDIENCE[r.audience])}</span>` : ''}${r.eta_label ? `<span>${esc(r.eta_label)}</span>` : ''}</div>
        <div class="d">${esc(r.description)}</div></li>`).join('')}</ul></div>`;
    }).join('');
    $('roadmap').innerHTML = lanes || '<div class="card empty">Nothing to share yet. Check back soon.</div>';
  }

  function renderIncidentPage() {
    const id = Number(new URLSearchParams(location.search).get('id'));
    const all = [...data.active_incidents, ...data.past_incidents];
    const i = all.find((x) => x.id === id);
    const main = $('incident-main');
    if (!i) { main.innerHTML = '<div class="card empty">This incident could not be found. It may be older than 90 days.</div>'; return; }
    document.title = `${i.title} · Fasta Status`;
    main.innerHTML = incidentCard(i, { full: true });
  }

  // ---------------------------------------------------------------- data
  function markOffline(cached) {
    const d = structuredClone(cached);
    d._offline = true;
    d.overall = { status: 'unavailable', text: 'Status unavailable' };
    d.components.forEach((c) => {
      if (c.status !== 'unavailable') c.last_confirmed = { status: c.status, at: d.last_checked_at || d.generated_at };
      c.status = 'unavailable';
    });
    return d;
  }

  async function load() {
    try {
      const r = await fetch('/api/status.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    } catch {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch {}
      if (cached && cached.components) data = markOffline(cached);
      else {
        data = { _offline: true, overall: { status: 'unavailable', text: 'Status unavailable' }, components: [], active_incidents: [], past_incidents: [], maintenance: { upcoming: [], in_progress: [], recent: [] }, changelog: [], roadmap: [], generated_at: Date.now(), last_checked_at: null };
      }
    }
    render();
  }

  function render() {
    if (!data) return;
    const now = Date.now();
    if (document.body.dataset.page === 'incident') return renderIncidentPage();
    renderStatus(now);
    if (data._offline && !data.components.length) {
      $('components').innerHTML = '<div class="empty">We can\'t reach the status service right now. Please try again in a minute.</div>';
      $('stale-note').hidden = true;
    }
    renderChangelog();
    renderRoadmap();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (b) { clFilter = b.dataset.f; renderChangelog(); }
  });
  window.addEventListener('hashchange', setView);
  if (document.body.dataset.page !== 'incident') setView();
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
