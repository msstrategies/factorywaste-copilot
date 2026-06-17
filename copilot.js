/*
 * copilot.js - The question-answering layer.
 *
 * Flow (mirrors the spec architecture):
 *   operator question (natural language)
 *     -> classify intent + extract entities (line, time window, metric)
 *     -> deterministic analysis layer answers (FactoryAnalysis)
 *     -> narrate the grounded result in plain language
 *
 * Two narration modes:
 *   1. MOCK (default, no key needed): a deterministic template narrator. It
 *      consumes ONLY the numbers from the analysis layer, so it is impossible
 *      for it to invent a figure. Runs fully offline.
 *   2. LLM (optional): if a Claude API key is provided at runtime via the
 *      settings panel, the same grounded facts are sent to Claude with a
 *      strict "narrate only these numbers, invent nothing" instruction.
 *
 * The key is NEVER hardcoded. It is read from a runtime field and never
 * persisted to disk. If absent, the app silently uses the mock narrator.
 */

(function (global) {
  'use strict';

  const A = global.FactoryAnalysis;

  // ---- Intent classification (deterministic, keyword + pattern based) -----
  // A real FDE build might route this through the LLM too, but keeping intent
  // parsing deterministic keeps the demo reliable and the eval set stable.
  function classify(question) {
    const q = question.toLowerCase();

    const intent = {
      raw: question,
      line: /line\s*3|line3/.test(q) ? 'Line 3' : 'Line 3', // single line in this slice
      metric: null,
      timeRef: null,
      type: null
    };

    if (/scrap|waste|defect|reject/.test(q)) intent.metric = 'scrap';
    else if (/throughput|output|units|production/.test(q)) intent.metric = 'throughput';
    else if (/temp|temperature|heater/.test(q)) intent.metric = 'injectionTempC';

    if (/yesterday/.test(q)) intent.timeRef = 'yesterday';
    else if (/today/.test(q)) intent.timeRef = 'today';
    else if (/last week|past week|this week/.test(q)) intent.timeRef = 'week';
    else if (/this month|last month|past month|30 day|month/.test(q)) intent.timeRef = 'month';

    // Question type.
    if (/recommend|should i|what.*do|fix|action|priorit/.test(q)) intent.type = 'recommendation';
    else if (/how many|count|number of|how often|recurr/.test(q)) intent.type = 'count';
    else if (/biggest|worst|largest|most/.test(q)) intent.type = 'biggest';
    else if (/why|cause|reason|correlat|because/.test(q)) intent.type = 'rootcause';
    else if (/total|overall|summary|how much.*waste|cost/.test(q)) intent.type = 'summary';
    else if (/spike|rise|spik|jump|increase/.test(q)) intent.type = 'rootcause';
    else intent.type = 'rootcause';

    return intent;
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return days[d.getDay()] + ' ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + hh + ':' + mm;
  }

  function fmtTimeOnly(iso) {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':00';
  }

  function dateStrFromRef(timeRef) {
    const now = new Date(A.result.meta.anchorNow);
    if (timeRef === 'today') {
      return now.toISOString().slice(0, 10);
    }
    if (timeRef === 'yesterday') {
      const y = new Date(now.getTime() - 24 * 3600 * 1000);
      return y.toISOString().slice(0, 10);
    }
    return null;
  }

  /*
   * resolve() turns an intent into a GROUNDED FACT OBJECT pulled entirely from
   * the deterministic layer. This object is the only thing the narrator (mock
   * or LLM) is allowed to speak from.
   */
  function resolve(intent) {
    const r = A.result;

    if (intent.type === 'recommendation') {
      return {
        kind: 'recommendation',
        recommendations: r.recommendations,
        totalExtraScrapUnits: r.totalExtraScrapUnits
      };
    }

    if (intent.type === 'summary') {
      return {
        kind: 'summary',
        totalSpikes: r.totalSpikes,
        totalExtraScrapUnits: r.totalExtraScrapUnits,
        baselineScrap: r.baseline.scrapRate,
        days: r.meta.days,
        recommendations: r.recommendations
      };
    }

    if (intent.type === 'count') {
      // If a signature is implied (temp/heater), count that cluster.
      let signature = null;
      if (intent.metric === 'injectionTempC' || /heater|temp/.test(intent.raw.toLowerCase())) {
        signature = 'injection_temp_drop';
      }
      if (signature) {
        const group = r.clusters[signature] || [];
        return {
          kind: 'count',
          signature: signature,
          count: group.length,
          totalSpikes: r.totalSpikes,
          spikes: group,
          cause: group.length ? group[0].primaryCause : null
        };
      }
      return {
        kind: 'count',
        signature: null,
        count: r.totalSpikes,
        totalSpikes: r.totalSpikes,
        spikes: r.spikes
      };
    }

    if (intent.type === 'biggest') {
      const s = A.biggestSpike();
      return { kind: 'spike', spike: s, sameSignatureCount: s ? A.signatureCount(s.primarySignature) : 0 };
    }

    // Default: root-cause on a referenced time window.
    let spike = null;
    const dateStr = dateStrFromRef(intent.timeRef);
    if (dateStr) {
      const onDate = A.spikesOnDate(dateStr);
      spike = onDate.length ? onDate[onDate.length - 1] : null;
    }
    if (!spike) {
      // Fall back to the most recent spike.
      spike = A.latestSpike();
    }
    return {
      kind: 'spike',
      spike: spike,
      timeRef: intent.timeRef,
      sameSignatureCount: spike ? A.signatureCount(spike.primarySignature) : 0
    };
  }

  // ---- MOCK narrator: speaks ONLY from the fact object -------------------
  function narrateMock(fact) {
    if (fact.kind === 'spike') {
      const s = fact.spike;
      if (!s) {
        return 'No scrap spike was detected in that window. Scrap stayed within the baseline band of about ' +
          A.result.baseline.scrapRate + '%.';
      }
      const dev = s.deviations.length ? s.deviations[0] : null;
      let txt = s.line + ' scrap rose from ' + s.baselineScrap + '% to ' + s.peakScrap +
        '% between ' + fmtTimeOnly(s.startTimestamp) + ' and ' + fmtTimeOnly(s.endTimestamp) +
        ' on ' + fmtDateTime(s.startTimestamp) + '.';
      if (dev) {
        txt += ' It correlates with a ' + Math.abs(dev.delta) + ' ' + dev.unit + ' ' + dev.direction +
          ' in ' + dev.label + ' on ' + s.machine + ' in the same window (' +
          dev.windowValue + ' ' + dev.unit + ' vs a baseline of ' + dev.baselineValue + ' ' + dev.unit +
          ', ' + Math.abs(dev.sigma) + ' sigma).';
      }
      if (fact.sameSignatureCount > 1) {
        txt += ' ' + fact.sameSignatureCount + ' of the ' + A.result.totalSpikes +
          ' detected spikes this month share that signature.';
      }
      txt += ' Estimated extra scrap in this event: ' + s.extraScrapUnits.toLocaleString() +
        ' units. Suggested check: ' + s.suggestedCheck + '.';
      return txt;
    }

    if (fact.kind === 'count') {
      if (fact.signature) {
        return 'There were ' + fact.count + ' scrap spikes this month with the ' +
          fact.cause + ' signature, out of ' + fact.totalSpikes + ' total detected spikes. ' +
          'A recurring signature like this is the strongest signal that the root cause is structural, not random.';
      }
      return A.result.totalSpikes + ' scrap spikes were detected across the ' +
        A.result.meta.days + '-day window.';
    }

    if (fact.kind === 'summary') {
      const top = fact.recommendations[0];
      let txt = 'Over the last ' + fact.days + ' days, ' + fact.totalSpikes +
        ' scrap spikes were detected against a baseline of ' + fact.baselineScrap +
        '%, costing an estimated ' + fact.totalExtraScrapUnits.toLocaleString() +
        ' extra scrapped units.';
      if (top) {
        txt += ' The single biggest lever is ' + top.cause + ' (' + top.occurrences +
          ' of ' + top.totalSpikes + ' spikes, ~' + top.totalExtraScrapUnits.toLocaleString() +
          ' units). Suggested check: ' + top.suggestedCheck + '.';
      }
      return txt;
    }

    if (fact.kind === 'recommendation') {
      if (!fact.recommendations.length) {
        return 'No recurring root cause is above the detection threshold right now. Scrap looks within normal variation.';
      }
      let txt = 'Prioritized actions, ranked by recurrence and waste:\n';
      fact.recommendations.forEach(function (rec, i) {
        txt += '\n' + (i + 1) + '. ' + rec.cause + ' - seen in ' + rec.occurrences +
          ' of ' + rec.totalSpikes + ' spikes, ~' + rec.totalExtraScrapUnits.toLocaleString() +
          ' extra scrap units. Check: ' + rec.suggestedCheck + '.';
      });
      txt += '\n\nThe recurring item is the highest-leverage fix: one calibration job removes a repeat offender.';
      return txt;
    }

    return 'I could not map that to the analysis. Try asking why scrap spiked yesterday, or what to fix first.';
  }

  // ---- LLM narrator (optional) ------------------------------------------
  // Sends ONLY the grounded fact object to Claude, with a hard instruction to
  // narrate and never invent numbers. Falls back to mock on any error.
  function buildGroundingPrompt(fact, question) {
    return [
      'You are FactoryWaste Copilot, helping a non-technical plant operator.',
      'Rules:',
      '1. Speak in plain, calm, factory-floor language. 2 to 4 sentences.',
      '2. You may ONLY use numbers present in the FACTS JSON below.',
      '3. Never invent or estimate a number that is not in FACTS.',
      '4. Always end with the single suggested check if one is present.',
      '',
      'OPERATOR QUESTION: ' + question,
      '',
      'FACTS (the deterministic analysis layer computed these, they are ground truth):',
      JSON.stringify(fact, null, 2)
    ].join('\n');
  }

  async function narrateLLM(fact, question, settings) {
    const prompt = buildGroundingPrompt(fact, question);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-3-5-haiku-latest',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!resp.ok) {
      throw new Error('Claude API returned ' + resp.status);
    }
    const json = await resp.json();
    const text = (json.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n')
      .trim();
    if (!text) throw new Error('Empty narration from Claude');
    return text;
  }

  /*
   * ask() is the public entry point. Returns:
   *   { intent, fact, answer, mode, spike }
   * mode is 'mock' or 'llm'. spike (if present) drives the trust panel.
   */
  async function ask(question, settings) {
    settings = settings || {};
    const intent = classify(question);
    const fact = resolve(intent);

    let answer;
    let mode = 'mock';
    if (settings.useLLM && settings.apiKey) {
      try {
        answer = await narrateLLM(fact, question, settings);
        mode = 'llm';
      } catch (e) {
        answer = narrateMock(fact);
        mode = 'mock-fallback';
        answer = '(LLM call failed, using grounded mock narrator) ' + answer;
      }
    } else {
      answer = narrateMock(fact);
    }

    const spike = fact.spike || (fact.spikes && fact.spikes.length ? fact.spikes[0] : null);
    return { intent: intent, fact: fact, answer: answer, mode: mode, spike: spike };
  }

  global.FactoryCopilot = {
    classify: classify,
    resolve: resolve,
    narrateMock: narrateMock,
    ask: ask,
    fmtDateTime: fmtDateTime,
    fmtTimeOnly: fmtTimeOnly
  };
})(typeof window !== 'undefined' ? window : globalThis);
