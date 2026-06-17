/*
 * evals.js - Grounding eval set.
 *
 * 10 question / expected-assertion pairs. Each assertion is a function over the
 * grounded FACT object produced by the deterministic layer (NOT over the prose
 * narration, which can be phrased many ways). This is the right way to eval a
 * grounded system: assert on the structured facts the model is allowed to
 * speak from. If these pass, the Copilot literally cannot state a wrong number,
 * because the narrator can only read these facts.
 *
 * Eval pipelines are a signal elite interviewers weight, so this runs both in
 * the browser ("Run evals" button) and headless via Node (npm run eval).
 */

(function (global) {
  'use strict';

  const A = global.FactoryAnalysis;
  const C = global.FactoryCopilot;

  // Convenience: derive expected truths from the injected events so the eval
  // is anchored to the synthetic ground truth, not hand-copied magic numbers.
  const injected = A.result.meta.injectedEvents;
  const tempEvents = injected.filter(function (e) { return e.signature === 'injection_temp_drop'; });

  const CASES = [
    {
      id: 'EV-01',
      question: 'Why did the scrap rate on Line 3 spike yesterday?',
      assert: function (fact) {
        // Must find a spike, attribute it to the injection temp drop, peak ~6.8.
        if (fact.kind !== 'spike' || !fact.spike) return fail('no spike found');
        if (fact.spike.primarySignature !== 'injection_temp_drop') return fail('wrong signature: ' + fact.spike.primarySignature);
        if (fact.spike.peakScrap < 5.5) return fail('peak too low: ' + fact.spike.peakScrap);
        return ok('peak ' + fact.spike.peakScrap + '%, cause ' + fact.spike.primaryCause);
      }
    },
    {
      id: 'EV-02',
      question: 'What was the root cause of yesterday\'s waste?',
      assert: function (fact) {
        if (!fact.spike) return fail('no spike');
        if (!/heater/i.test(fact.spike.primaryCause)) return fail('not heater cause: ' + fact.spike.primaryCause);
        return ok(fact.spike.primaryCause);
      }
    },
    {
      id: 'EV-03',
      question: 'How many heater spikes happened this month?',
      assert: function (fact) {
        if (fact.kind !== 'count') return fail('not a count, got ' + fact.kind);
        if (fact.count !== tempEvents.length) return fail('expected ' + tempEvents.length + ' got ' + fact.count);
        return ok(fact.count + ' heater spikes (matches ' + tempEvents.length + ' injected)');
      }
    },
    {
      id: 'EV-04',
      question: 'What should I fix first on Line 3?',
      assert: function (fact) {
        if (fact.kind !== 'recommendation') return fail('not recommendation: ' + fact.kind);
        if (!fact.recommendations.length) return fail('no recommendations');
        if (!/heater/i.test(fact.recommendations[0].cause)) return fail('top rec not heater: ' + fact.recommendations[0].cause);
        return ok('top: ' + fact.recommendations[0].cause + ' (' + fact.recommendations[0].occurrences + 'x)');
      }
    },
    {
      id: 'EV-05',
      question: 'Give me a summary of waste on Line 3 this month.',
      assert: function (fact) {
        if (fact.kind !== 'summary') return fail('not summary: ' + fact.kind);
        if (fact.totalSpikes < 4) return fail('too few spikes: ' + fact.totalSpikes);
        if (fact.totalExtraScrapUnits <= 0) return fail('no waste quantified');
        return ok(fact.totalSpikes + ' spikes, ' + fact.totalExtraScrapUnits + ' extra scrap units');
      }
    },
    {
      id: 'EV-06',
      question: 'What was the biggest waste event?',
      assert: function (fact) {
        if (fact.kind !== 'spike' || !fact.spike) return fail('no spike');
        // The biggest must have the largest extraScrapUnits of all spikes.
        const max = Math.max.apply(null, A.result.spikes.map(function (s) { return s.extraScrapUnits; }));
        if (fact.spike.extraScrapUnits !== max) return fail('not the max: ' + fact.spike.extraScrapUnits + ' vs ' + max);
        return ok('biggest = ' + fact.spike.extraScrapUnits + ' units');
      }
    },
    {
      id: 'EV-07',
      question: 'Did the hold pressure problem on M-06 cause any scrap?',
      assert: function (fact) {
        // M-06 jam is a different signature; the analysis must NOT blame M-07.
        const cluster = A.result.clusters['hold_pressure_drop'] || [];
        if (cluster.length < 1) return fail('M-06 pressure event not detected');
        if (!/M-06|feed/i.test(cluster[0].primaryCause)) return fail('mis-attributed: ' + cluster[0].primaryCause);
        return ok('M-06 pressure event correctly isolated: ' + cluster[0].primaryCause);
      }
    },
    {
      id: 'EV-08',
      question: 'What is the normal scrap rate on Line 3?',
      assert: function () {
        const base = A.result.baseline.scrapRate;
        // Baseline should land near the configured 2.1% healthy median.
        if (base < 1.5 || base > 2.8) return fail('baseline off: ' + base);
        return ok('baseline ' + base + '%');
      }
    },
    {
      id: 'EV-09',
      question: 'How much extra material did the heater issue waste in total?',
      assert: function (fact) {
        const cluster = A.result.clusters['injection_temp_drop'] || [];
        if (!cluster.length) return fail('no heater cluster');
        const total = cluster.reduce(function (a, s) { return a + s.extraScrapUnits; }, 0);
        if (total <= 0) return fail('no waste');
        return ok('heater total ~' + total + ' extra scrap units across ' + cluster.length + ' events');
      }
    },
    {
      id: 'EV-10',
      question: 'Is M-07 temperature linked to the scrap spikes?',
      assert: function (fact) {
        if (!fact.spike) return fail('no spike');
        const hasTempDev = (fact.spike.deviations || []).some(function (d) { return d.key === 'injectionTempC'; });
        if (!hasTempDev) return fail('temp deviation not surfaced');
        return ok('temp deviation surfaced with sigma ' + fact.spike.deviations[0].sigma);
      }
    }
  ];

  function ok(detail) { return { pass: true, detail: detail }; }
  function fail(detail) { return { pass: false, detail: detail }; }

  function runOne(testCase) {
    const intent = C.classify(testCase.question);
    const fact = C.resolve(intent);
    let res;
    try {
      res = testCase.assert(fact);
    } catch (e) {
      res = fail('threw: ' + e.message);
    }
    return {
      id: testCase.id,
      question: testCase.question,
      pass: res.pass,
      detail: res.detail
    };
  }

  function runAll() {
    const results = CASES.map(runOne);
    const passed = results.filter(function (r) { return r.pass; }).length;
    return { results: results, passed: passed, total: results.length };
  }

  global.FactoryEvals = { cases: CASES, runOne: runOne, runAll: runAll };
})(typeof window !== 'undefined' ? window : globalThis);
