/*
 * analysis.js - Deterministic waste-analysis engine.
 *
 * This is the heart of the FDE thesis: the numbers come from plain, auditable
 * rules, NOT a black-box model. An operator can follow every step. The LLM
 * layer (copilot.js) is only allowed to narrate what this file computes. It
 * may never invent a number.
 *
 * What it does:
 *  1. Establishes a robust baseline scrap rate (median of healthy hours).
 *  2. Detects scrap spikes (hours where scrap exceeds baseline by a threshold).
 *  3. Groups consecutive spike hours into spike events.
 *  4. For each spike, correlates against sensor deviations in the same window
 *     to attribute a likely root cause.
 *  5. Clusters spikes by shared signature so it can say "N of the last M
 *     spikes share this signature".
 *  6. Quantifies the waste (extra scrapped units) and ranks recommendations.
 *
 * Pure functions over FactoryData. No network, no randomness.
 */

(function (global) {
  'use strict';

  const data = global.FactoryData;
  const rows = data.rows;
  const meta = data.meta;

  // ---- Small statistics helpers -----------------------------------------
  function median(arr) {
    if (arr.length === 0) return 0;
    const s = arr.slice().sort(function (a, b) {
      return a - b;
    });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce(function (a, b) {
      return a + b;
    }, 0) / arr.length;
  }

  function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v =
      arr.reduce(function (a, b) {
        return a + (b - m) * (b - m);
      }, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }

  function round(x, dp) {
    const f = Math.pow(10, dp);
    return Math.round(x * f) / f;
  }

  // ---- Detection thresholds (explicit, tunable, auditable) ---------------
  const CONFIG = {
    // A spike hour is one where scrap exceeds baseline + this many points.
    scrapSpikeAbsoluteDelta: 1.8, // percentage points over baseline
    // Sensor deviation flagged when it moves more than this many sigma from
    // the healthy baseline for that sensor.
    sensorSigmaThreshold: 2.5,
    // Sensors we attribute root cause from, with human labels and direction.
    sensors: [
      {
        key: 'injectionTempC',
        label: 'injection temperature',
        unit: 'deg C',
        signature: 'injection_temp_drop',
        cause: 'M-07 heater calibration drift',
        check: 'M-07 heater calibration and barrel thermocouple'
      },
      {
        key: 'holdPressureBar',
        label: 'hold pressure',
        unit: 'bar',
        signature: 'hold_pressure_drop',
        cause: 'M-06 material feed jam (moisture in feedstock)',
        check: 'M-06 hopper / feed throat and material dryer'
      },
      {
        key: 'cycleTimeS',
        label: 'cycle time',
        unit: 's',
        signature: 'cycle_time_rise',
        cause: 'cycle slowdown',
        check: 'machine cycle program and clamp timing'
      }
    ]
  };

  // ---- Baseline from healthy hours --------------------------------------
  // Healthy = hours with no injected event AND scrap below a generous cutoff.
  // We compute baseline only on healthy hours so spikes do not pollute it.
  function buildBaseline() {
    const healthy = rows.filter(function (r) {
      return r.eventId === null;
    });
    const baseline = {
      scrapRate: round(median(healthy.map(function (r) { return r.scrapRate; })), 2),
      throughput: round(median(healthy.map(function (r) { return r.throughput; })), 0)
    };
    const sensors = {};
    CONFIG.sensors.forEach(function (s) {
      const vals = healthy.map(function (r) { return r[s.key]; });
      sensors[s.key] = {
        median: round(median(vals), 2),
        mean: round(mean(vals), 2),
        sd: round(stddev(vals), 3)
      };
    });
    baseline.sensors = sensors;
    return baseline;
  }

  const BASELINE = buildBaseline();

  // ---- Spike hour flagging ----------------------------------------------
  function flagSpikeHours() {
    const cutoff = BASELINE.scrapRate + CONFIG.scrapSpikeAbsoluteDelta;
    return rows.map(function (r) {
      return {
        index: r.index,
        timestamp: r.timestamp,
        scrapRate: r.scrapRate,
        isSpike: r.scrapRate >= cutoff
      };
    });
  }

  // ---- Group consecutive spike hours into spike events -------------------
  function groupSpikes(flags) {
    const events = [];
    let cur = null;
    flags.forEach(function (f) {
      if (f.isSpike) {
        if (cur === null) {
          cur = { startIndex: f.index, endIndex: f.index };
        } else {
          cur.endIndex = f.index;
        }
      } else if (cur !== null) {
        events.push(cur);
        cur = null;
      }
    });
    if (cur !== null) events.push(cur);
    return events;
  }

  // ---- Attribute root cause by correlating sensor deviations ------------
  function attribute(spike) {
    const window = rows.slice(spike.startIndex, spike.endIndex + 1);
    const peakScrap = Math.max.apply(
      null,
      window.map(function (r) { return r.scrapRate; })
    );
    const meanScrap = mean(window.map(function (r) { return r.scrapRate; }));
    const meanThroughput = mean(window.map(function (r) { return r.throughput; }));

    const deviations = [];
    CONFIG.sensors.forEach(function (s) {
      const base = BASELINE.sensors[s.key];
      const winMean = mean(window.map(function (r) { return r[s.key]; }));
      const sigma = base.sd === 0 ? 0 : (winMean - base.median) / base.sd;
      const absSigma = Math.abs(sigma);
      if (absSigma >= CONFIG.sensorSigmaThreshold) {
        deviations.push({
          key: s.key,
          label: s.label,
          unit: s.unit,
          signature: s.signature,
          cause: s.cause,
          check: s.check,
          baselineValue: base.median,
          windowValue: round(winMean, 2),
          delta: round(winMean - base.median, 2),
          sigma: round(sigma, 1),
          absSigma: absSigma,
          direction: sigma < 0 ? 'drop' : 'rise'
        });
      }
    });

    // Rank deviations by magnitude; strongest is the attributed primary cause.
    deviations.sort(function (a, b) { return b.absSigma - a.absSigma; });
    const primary = deviations.length ? deviations[0] : null;

    // Quantify waste: extra scrapped units vs baseline scrap rate over window.
    let extraScrapUnits = 0;
    window.forEach(function (r) {
      const extraRate = Math.max(0, r.scrapRate - BASELINE.scrapRate) / 100;
      extraScrapUnits += extraRate * r.throughput;
    });

    return {
      startIndex: spike.startIndex,
      endIndex: spike.endIndex,
      startTimestamp: rows[spike.startIndex].timestamp,
      endTimestamp: rows[spike.endIndex].timestamp,
      durationH: spike.endIndex - spike.startIndex + 1,
      baselineScrap: BASELINE.scrapRate,
      peakScrap: round(peakScrap, 2),
      meanScrap: round(meanScrap, 2),
      meanThroughput: round(meanThroughput, 0),
      extraScrapUnits: Math.round(extraScrapUnits),
      deviations: deviations,
      primarySignature: primary ? primary.signature : 'unattributed',
      primaryCause: primary ? primary.cause : 'no single sensor deviation above threshold',
      suggestedCheck: primary ? primary.check : 'manual inspection of the window',
      machine: rows[spike.startIndex].machine,
      line: rows[spike.startIndex].line
    };
  }

  // ---- Cluster spikes by shared signature -------------------------------
  function clusterBySignature(spikes) {
    const clusters = {};
    spikes.forEach(function (s) {
      const sig = s.primarySignature;
      if (!clusters[sig]) clusters[sig] = [];
      clusters[sig].push(s);
    });
    return clusters;
  }

  // ---- Top-level run -----------------------------------------------------
  function run() {
    const flags = flagSpikeHours();
    const grouped = groupSpikes(flags);
    const spikes = grouped.map(attribute);
    const clusters = clusterBySignature(spikes);

    // Rank recommendations: by recurring signatures and total waste.
    const recommendations = Object.keys(clusters)
      .filter(function (sig) { return sig !== 'unattributed'; })
      .map(function (sig) {
        const group = clusters[sig];
        const totalWaste = group.reduce(function (a, s) {
          return a + s.extraScrapUnits;
        }, 0);
        const sample = group[0];
        return {
          signature: sig,
          cause: sample.primaryCause,
          suggestedCheck: sample.suggestedCheck,
          occurrences: group.length,
          totalSpikes: spikes.length,
          totalExtraScrapUnits: totalWaste,
          lastSeen: group[group.length - 1].endTimestamp
        };
      })
      .sort(function (a, b) {
        // Recurring + costly first.
        if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
        return b.totalExtraScrapUnits - a.totalExtraScrapUnits;
      });

    const totalWaste = spikes.reduce(function (a, s) {
      return a + s.extraScrapUnits;
    }, 0);

    return {
      baseline: BASELINE,
      config: CONFIG,
      spikes: spikes,
      clusters: clusters,
      recommendations: recommendations,
      totalSpikes: spikes.length,
      totalExtraScrapUnits: totalWaste,
      meta: meta
    };
  }

  const RESULT = run();

  // ---- Query helpers used by the copilot --------------------------------

  // Find the spike whose window overlaps a given day (local date string).
  function spikesOnDate(dateStr) {
    return RESULT.spikes.filter(function (s) {
      const d1 = new Date(s.startTimestamp);
      const d2 = new Date(s.endTimestamp);
      const target = new Date(dateStr + 'T00:00:00');
      const next = new Date(target.getTime() + 24 * 3600 * 1000);
      return d2 >= target && d1 < next;
    });
  }

  // The most recent spike (used for "yesterday" / "latest" questions).
  function latestSpike() {
    return RESULT.spikes.length ? RESULT.spikes[RESULT.spikes.length - 1] : null;
  }

  // Largest spike by waste.
  function biggestSpike() {
    if (!RESULT.spikes.length) return null;
    return RESULT.spikes.slice().sort(function (a, b) {
      return b.extraScrapUnits - a.extraScrapUnits;
    })[0];
  }

  // Raw rows in a window, for the "show the data behind it" trust panel.
  function rowsInWindow(startIndex, endIndex, pad) {
    pad = pad || 0;
    const a = Math.max(0, startIndex - pad);
    const b = Math.min(rows.length - 1, endIndex + pad);
    return rows.slice(a, b + 1);
  }

  // How many spikes share a given signature.
  function signatureCount(signature) {
    return (RESULT.clusters[signature] || []).length;
  }

  global.FactoryAnalysis = {
    result: RESULT,
    baseline: BASELINE,
    config: CONFIG,
    spikesOnDate: spikesOnDate,
    latestSpike: latestSpike,
    biggestSpike: biggestSpike,
    rowsInWindow: rowsInWindow,
    signatureCount: signatureCount,
    helpers: { median: median, mean: mean, stddev: stddev, round: round }
  };
})(typeof window !== 'undefined' ? window : globalThis);
