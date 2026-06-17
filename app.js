/*
 * app.js - UI wiring for FactoryWaste Copilot.
 *
 * Responsibilities:
 *  - render KPI strip from the deterministic analysis
 *  - handle the chat loop (question -> FactoryCopilot.ask -> bubble)
 *  - render the trust panel (fact card + scrap chart + raw hourly rows)
 *  - settings modal (optional Claude key, in-memory only)
 *  - eval modal (runs FactoryEvals in the browser)
 *
 * No framework on purpose: an FDE demo should run by double-clicking the file.
 */

(function () {
  'use strict';

  const A = window.FactoryAnalysis;
  const C = window.FactoryCopilot;
  const E = window.FactoryEvals;
  const D = window.FactoryData;

  // Settings live in memory only. The key is never persisted.
  const settings = { useLLM: false, apiKey: '', model: 'claude-3-5-haiku-latest' };

  const $ = function (id) { return document.getElementById(id); };

  // ---- KPI strip ---------------------------------------------------------
  function renderKPIs() {
    const r = A.result;
    const total = r.totalExtraScrapUnits.toLocaleString();
    const topRec = r.recommendations[0];
    const html = [
      kpi('Baseline scrap', r.baseline.scrapRate + '%', '', 'healthy median'),
      kpi('Spikes detected', String(r.totalSpikes), 'warn', 'in last ' + r.meta.days + ' days'),
      kpi('Extra scrap', total + ' u', 'bad', 'above baseline'),
      kpi('Top root cause', topRec ? topRec.occurrences + 'x' : '0',
          topRec ? 'warn' : '', topRec ? shortCause(topRec.cause) : 'none')
    ].join('');
    $('kpis').innerHTML = html;
  }

  function shortCause(c) {
    return c.replace(/\s*\(.*\)\s*/, '').replace('calibration drift', 'cal. drift');
  }

  function kpi(label, value, cls, foot) {
    return '<div class="kpi"><div class="label">' + label + '</div>' +
      '<div class="value ' + (cls || '') + '">' + value + '</div>' +
      '<div class="foot">' + foot + '</div></div>';
  }

  // ---- Suggestion chips --------------------------------------------------
  const SUGGESTIONS = [
    'Why did the scrap rate on Line 3 spike yesterday?',
    'What should I fix first?',
    'How many heater spikes this month?',
    'Give me a summary of waste this month',
    'What was the biggest waste event?'
  ];

  function renderSuggestions() {
    $('suggestions').innerHTML = SUGGESTIONS.map(function (s) {
      return '<button class="chip" data-q="' + escapeAttr(s) + '">' + escapeHtml(s) + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (el) {
      el.addEventListener('click', function () {
        $('questionInput').value = el.getAttribute('data-q');
        submitQuestion();
      });
    });
  }

  // ---- Messages ----------------------------------------------------------
  function addMessage(role, text, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);

    if (role === 'bot' && opts.mode) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = document.createElement('span');
      const isLLM = opts.mode === 'llm';
      tag.className = 'mode-tag ' + (isLLM ? 'llm' : 'mock');
      tag.textContent = isLLM ? 'narrated by Claude (grounded)' :
        (opts.mode === 'mock-fallback' ? 'mock fallback (grounded)' : 'deterministic narrator (grounded)');
      meta.appendChild(tag);

      if (opts.spike) {
        const link = document.createElement('a');
        link.className = 'trust-link';
        link.style.marginLeft = '10px';
        link.textContent = 'show the data behind this';
        link.addEventListener('click', function () { renderTrust(opts.spike); });
        meta.appendChild(link);
      }
      wrap.appendChild(meta);
    }

    $('messages').appendChild(wrap);
    $('messages').scrollTop = $('messages').scrollHeight;
    return bubble;
  }

  // ---- Trust panel: fact card + chart + raw rows ------------------------
  function renderTrust(spike) {
    if (!spike) {
      $('panelBody').innerHTML = '<div class="empty-state">No spike object for this answer. Try a question about a specific waste event.</div>';
      return;
    }
    $('panelTitle').textContent = 'The data behind the answer';
    $('panelSub').textContent = 'Window: ' + C.fmtDateTime(spike.startTimestamp) +
      ' to ' + C.fmtTimeOnly(spike.endTimestamp) + ' on ' + spike.line;

    const dev = spike.deviations && spike.deviations.length ? spike.deviations[0] : null;

    let html = '<div class="fact-card"><h3>Computed analysis</h3>';
    html += factRow('Line / machine', spike.line + ' / ' + spike.machine);
    html += factRow('Baseline scrap', spike.baselineScrap + '%');
    html += factRow('Peak scrap', spike.peakScrap + '%', 'bad');
    html += factRow('Mean scrap (window)', spike.meanScrap + '%', 'warn');
    html += factRow('Duration', spike.durationH + ' h');
    if (dev) {
      html += factRow('Sensor signal', dev.label + ' ' + dev.direction);
      html += factRow('Sensor value', dev.windowValue + ' ' + dev.unit + ' (base ' + dev.baselineValue + ')', 'warn');
      html += factRow('Deviation', dev.delta + ' ' + dev.unit + ' (' + dev.sigma + ' sigma)', 'warn');
    }
    html += factRow('Extra scrap (est.)', spike.extraScrapUnits.toLocaleString() + ' units', 'bad');
    html += factRow('Attributed cause', spike.primaryCause);
    html += factRow('Suggested check', spike.suggestedCheck);
    html += '</div>';

    // Chart of scrap rate across a padded window.
    const padded = A.rowsInWindow(spike.startIndex, spike.endIndex, 8);
    html += '<div class="chart-wrap"><div class="chart-title">Scrap rate, hourly (red = flagged spike)</div>' +
      renderChart(padded, spike) + '</div>';

    // Raw rows table.
    html += '<div class="chart-title">Raw hourly rows (the source of truth)</div>';
    html += renderRawTable(padded);
    html += '<div class="legend"><span class="swatch"></span>flagged spike hour - every figure above is computed from these rows by analysis.js</div>';

    $('panelBody').innerHTML = html;
    if (window.innerWidth <= 980) $('panel').classList.add('mobile-show');
  }

  function factRow(k, v, cls) {
    return '<div class="fact-row"><span class="k">' + escapeHtml(k) + '</span>' +
      '<span class="v ' + (cls || '') + '">' + escapeHtml(String(v)) + '</span></div>';
  }

  function renderChart(rows, spike) {
    const w = 384, h = 130, padL = 28, padB = 18, padT = 8;
    const vals = rows.map(function (r) { return r.scrapRate; });
    const maxV = Math.max.apply(null, vals) * 1.1;
    const minV = 0;
    const n = rows.length;
    const xStep = (w - padL - 6) / Math.max(1, n - 1);
    function x(i) { return padL + i * xStep; }
    function y(v) { return padT + (h - padT - padB) * (1 - (v - minV) / (maxV - minV)); }

    let pts = '';
    let bars = '';
    rows.forEach(function (r, i) {
      pts += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(r.scrapRate).toFixed(1) + ' ';
      const flagged = r.index >= spike.startIndex && r.index <= spike.endIndex;
      if (flagged) {
        bars += '<rect x="' + (x(i) - 3).toFixed(1) + '" y="' + y(r.scrapRate).toFixed(1) +
          '" width="6" height="' + (h - padB - y(r.scrapRate)).toFixed(1) +
          '" fill="rgba(248,81,73,0.35)" />';
      }
    });

    // Baseline reference line.
    const baseY = y(spike.baselineScrap);
    const baseLine = '<line x1="' + padL + '" y1="' + baseY.toFixed(1) + '" x2="' + (w - 6) +
      '" y2="' + baseY.toFixed(1) + '" stroke="#3fb950" stroke-dasharray="3 3" stroke-width="1" />';

    const yLabels = '<text x="2" y="' + (y(maxV) + 4).toFixed(1) + '" fill="#8da2b5" font-size="9">' +
      maxV.toFixed(0) + '%</text>' +
      '<text x="2" y="' + (h - padB).toFixed(1) + '" fill="#8da2b5" font-size="9">0</text>' +
      '<text x="' + (padL + 4) + '" y="' + (baseY - 3).toFixed(1) + '" fill="#3fb950" font-size="9">baseline ' + spike.baselineScrap + '%</text>';

    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      bars + baseLine +
      '<path d="' + pts + '" fill="none" stroke="#2f81f7" stroke-width="2" />' +
      yLabels +
      '</svg>';
  }

  function renderRawTable(rows) {
    let html = '<div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;">';
    html += '<table class="raw"><thead><tr>' +
      '<th>time</th><th>scrap%</th><th>thrpt</th><th>inj.temp</th><th>hold.bar</th><th>cyc.s</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      const flagged = r.eventId !== null;
      html += '<tr class="' + (flagged ? 'flag' : '') + '">' +
        '<td>' + C.fmtTimeOnly(r.timestamp) + '</td>' +
        '<td>' + r.scrapRate.toFixed(2) + '</td>' +
        '<td>' + r.throughput + '</td>' +
        '<td>' + r.injectionTempC.toFixed(1) + '</td>' +
        '<td>' + r.holdPressureBar.toFixed(1) + '</td>' +
        '<td>' + r.cycleTimeS.toFixed(2) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  // ---- Ask loop ----------------------------------------------------------
  async function submitQuestion() {
    const input = $('questionInput');
    const q = input.value.trim();
    if (!q) return;
    addMessage('user', q);
    input.value = '';

    const thinking = addMessage('bot', 'Analysing the line data...', { mode: 'mock' });

    try {
      const res = await C.ask(q, settings);
      thinking.parentNode.remove();
      addMessage('bot', res.answer, { mode: res.mode, spike: res.spike });
      if (res.spike) renderTrust(res.spike);
      else if (res.fact && res.fact.kind === 'recommendation') renderRecommendations(res.fact);
      else if (res.fact && res.fact.kind === 'summary') renderRecommendations({ recommendations: res.fact.recommendations });
    } catch (e) {
      thinking.parentNode.remove();
      addMessage('bot', 'Something went wrong analysing that. (' + e.message + ')', { mode: 'mock' });
    }
  }

  function renderRecommendations(fact) {
    $('panelTitle').textContent = 'Prioritized recommendations';
    $('panelSub').textContent = 'Ranked by recurrence and total waste, computed by analysis.js';
    let html = '';
    (fact.recommendations || []).forEach(function (rec, i) {
      html += '<div class="fact-card"><h3>' + (i + 1) + '. ' + escapeHtml(rec.cause) + '</h3>';
      html += factRow('Occurrences', rec.occurrences + ' of ' + rec.totalSpikes + ' spikes', 'warn');
      html += factRow('Extra scrap', rec.totalExtraScrapUnits.toLocaleString() + ' units', 'bad');
      html += factRow('Suggested check', rec.suggestedCheck);
      html += factRow('Last seen', C.fmtDateTime(rec.lastSeen));
      html += '</div>';
    });
    if (!html) html = '<div class="empty-state">No recurring root cause above threshold.</div>';
    $('panelBody').innerHTML = html;
  }

  // ---- Settings ----------------------------------------------------------
  function openSettings() {
    $('useLLM').checked = settings.useLLM;
    $('apiKey').value = settings.apiKey;
    $('model').value = settings.model;
    $('modalBackdrop').classList.add('open');
  }
  function closeSettings() { $('modalBackdrop').classList.remove('open'); }
  function saveSettings() {
    settings.useLLM = $('useLLM').checked;
    settings.apiKey = $('apiKey').value.trim();
    settings.model = $('model').value;
    closeSettings();
    const mode = settings.useLLM && settings.apiKey ? 'Claude narration enabled.' : 'Deterministic mock narration (offline).';
    addMessage('bot', 'Settings saved. ' + mode, { mode: settings.useLLM && settings.apiKey ? 'llm' : 'mock' });
  }

  // ---- Evals -------------------------------------------------------------
  function runEvalsUI() {
    const summary = E.runAll();
    let html = '<div class="eval-summary">Result: <span class="score">' +
      summary.passed + '/' + summary.total + '</span> grounded eval cases passed.</div>';
    summary.results.forEach(function (r) {
      html += '<div class="eval-item ' + (r.pass ? 'pass' : 'fail') + '">' +
        '<span class="tag">' + (r.pass ? 'PASS' : 'FAIL') + '</span>' +
        '<span class="q">' + escapeHtml(r.question) + '</span>' +
        '<div class="d">' + escapeHtml(r.detail) + '</div></div>';
    });
    $('evalResults').innerHTML = html;
    $('evalBackdrop').classList.add('open');
  }

  // ---- Utilities ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ---- Init --------------------------------------------------------------
  function init() {
    renderKPIs();
    renderSuggestions();
    $('dataPill').textContent = D.meta.line + ' - ' + D.meta.days + ' days - ' + D.meta.hours + ' hourly rows';

    addMessage('bot',
      'Hi. I am FactoryWaste Copilot for ' + D.meta.line + '. Ask me, in plain language, ' +
      'why the line is wasting material. I answer only from the line data and show you the numbers behind every answer. ' +
      'Note: this is synthetic demo data, not real factory data.',
      { mode: 'mock' });

    $('composer').addEventListener('submit', function (e) { e.preventDefault(); submitQuestion(); });
    $('settingsBtn').addEventListener('click', openSettings);
    $('modalCancel').addEventListener('click', closeSettings);
    $('modalSave').addEventListener('click', saveSettings);
    $('evalBtn').addEventListener('click', runEvalsUI);
    $('evalClose').addEventListener('click', function () { $('evalBackdrop').classList.remove('open'); });
    $('modalBackdrop').addEventListener('click', function (e) { if (e.target === $('modalBackdrop')) closeSettings(); });
    $('evalBackdrop').addEventListener('click', function (e) { if (e.target === $('evalBackdrop')) $('evalBackdrop').classList.remove('open'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
