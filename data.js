/*
 * data.js - Synthetic production dataset generator.
 *
 * One injection-molding production line (Line 3), ~30 days of hourly rows.
 * Each row: throughput, scrap rate, 3 sensor readings, machine ID.
 *
 * IMPORTANT: This is 100% synthetic data, deterministically generated from a
 * fixed seed so the demo is reproducible and offline. It is NOT EthonAI data
 * and not real factory data. A Forward Deployed Engineer cannot have a
 * customer's real data on day one, so the honest move is to model the shape
 * of the problem with synthetic data and say so plainly.
 *
 * Four waste events are deliberately injected, each with a detectable,
 * explainable signature so the deterministic analysis layer (analysis.js)
 * can find them without a black-box model.
 */

(function (global) {
  'use strict';

  // ---- Deterministic PRNG (mulberry32) so the dataset is identical every run.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rand = mulberry32(20260617);

  function gaussian(mean, sd) {
    // Box-Muller transform on the seeded PRNG.
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + z * sd;
  }

  function round(x, dp) {
    const f = Math.pow(10, dp);
    return Math.round(x * f) / f;
  }

  // ---- Configuration ------------------------------------------------------
  const LINE_ID = 'Line 3';
  const DAYS = 30;
  const HOURS = DAYS * 24;

  // The line runs three machines in series. M-07 is the injection unit and is
  // the one with intermittent heater trouble (the recurring signature).
  const MACHINES = ['M-05', 'M-06', 'M-07'];

  // Baselines for a healthy hour.
  const BASE = {
    throughput: 480, // units/hour
    scrapRate: 2.1, // percent
    injectionTempC: 224, // M-07 barrel temperature, deg C
    holdPressureBar: 95, // injection hold pressure, bar
    cycleTimeS: 28.5 // seconds per cycle
  };

  // The dataset starts 30 days before "now". "Now" is pinned to a fixed
  // wall-clock so relative questions ("yesterday") are reproducible.
  const ANCHOR_NOW = new Date('2026-06-17T08:00:00');
  const START = new Date(ANCHOR_NOW.getTime() - HOURS * 3600 * 1000);

  // Hour index (from START) for a given local date/hour, so injected events
  // can be pinned to real wall-clock windows like "yesterday 14:00".
  function hourIndexFor(date, hour) {
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0);
    return Math.round((target.getTime() - START.getTime()) / (3600 * 1000));
  }
  const YESTERDAY = new Date(ANCHOR_NOW.getTime() - 24 * 3600 * 1000);
  const E4_START_HOUR = hourIndexFor(YESTERDAY, 14); // yesterday, 14:00 local

  /*
   * Injected waste events. Each has:
   *  - a human label and root-cause signature
   *  - a start hour offset and duration
   *  - a mutator that applies the signature to a row
   * Three of the four share the M-07 injection-temperature-drop signature,
   * which is what lets the analysis layer say "3 of the last N spikes share
   * this signature".
   */
  const EVENTS = [
    {
      id: 'E1',
      label: 'M-07 heater calibration drift',
      machine: 'M-07',
      signature: 'injection_temp_drop',
      dayOffset: 5,
      startHour: 5 * 24 + 2,
      durationH: 5,
      mutate: function (row, t) {
        // Barrel temp sags ~5 deg, scrap climbs, throughput dips slightly.
        row.injectionTempC -= 5.2 + 0.4 * Math.sin(t);
        row.scrapRate += 4.4;
        row.throughput -= 38;
        row.cycleTimeS += 0.8;
      }
    },
    {
      id: 'E2',
      label: 'M-06 material feed jam (moisture)',
      machine: 'M-06',
      signature: 'hold_pressure_drop',
      dayOffset: 12,
      startHour: 12 * 24 + 9,
      durationH: 4,
      mutate: function (row) {
        // Different signature: pressure collapses, temp normal. This is the
        // control case that proves the correlation logic is specific, not
        // "blame M-07 for everything".
        row.holdPressureBar -= 14;
        row.scrapRate += 3.6;
        row.throughput -= 52;
        row.cycleTimeS += 1.4;
      }
    },
    {
      id: 'E3',
      label: 'M-07 heater calibration drift (recurrence)',
      machine: 'M-07',
      signature: 'injection_temp_drop',
      dayOffset: 21,
      startHour: 21 * 24 + 14, // 14:00 on day 21
      durationH: 3,
      mutate: function (row, t) {
        row.injectionTempC -= 4.6 + 0.5 * Math.cos(t);
        row.scrapRate += 4.7;
        row.throughput -= 34;
        row.cycleTimeS += 0.7;
      }
    },
    {
      id: 'E4',
      label: 'M-07 heater calibration drift (yesterday)',
      machine: 'M-07',
      signature: 'injection_temp_drop',
      // Pinned to yesterday 14:00-16:00 local relative to ANCHOR_NOW, so the
      // "spike yesterday" question maps to a real, dated window in the data.
      dayOffset: 29,
      startHour: E4_START_HOUR,
      durationH: 3,
      mutate: function (row, t) {
        row.injectionTempC -= 4.1 + 0.3 * Math.sin(t);
        row.scrapRate += 4.7; // 2.1 -> ~6.8, matches the spec narrative
        row.throughput -= 31;
        row.cycleTimeS += 0.6;
      }
    }
  ];

  function isInEvent(hourIndex) {
    for (let i = 0; i < EVENTS.length; i++) {
      const e = EVENTS[i];
      if (hourIndex >= e.startHour && hourIndex < e.startHour + e.durationH) {
        return e;
      }
    }
    return null;
  }

  function buildRows() {
    const rows = [];
    for (let h = 0; h < HOURS; h++) {
      const ts = new Date(START.getTime() + h * 3600 * 1000);
      const hourOfDay = ts.getHours();

      // Gentle production rhythm: lower throughput on night shift.
      const nightShift = hourOfDay >= 0 && hourOfDay < 6;
      const shiftFactor = nightShift ? 0.86 : 1.0;

      const row = {
        index: h,
        timestamp: ts.toISOString(),
        line: LINE_ID,
        machine: 'M-07', // primary injection machine, the one operators ask about
        throughput: round(gaussian(BASE.throughput * shiftFactor, 9), 0),
        scrapRate: round(Math.max(0.3, gaussian(BASE.scrapRate, 0.35)), 2),
        injectionTempC: round(gaussian(BASE.injectionTempC, 0.9), 1),
        holdPressureBar: round(gaussian(BASE.holdPressureBar, 1.4), 1),
        cycleTimeS: round(gaussian(BASE.cycleTimeS, 0.4), 2),
        eventId: null
      };

      const ev = isInEvent(h);
      if (ev) {
        ev.mutate(row, h);
        row.scrapRate = round(Math.max(0.3, row.scrapRate), 2);
        row.injectionTempC = round(row.injectionTempC, 1);
        row.holdPressureBar = round(row.holdPressureBar, 1);
        row.throughput = round(row.throughput, 0);
        row.cycleTimeS = round(row.cycleTimeS, 2);
        row.eventId = ev.id;
      }
      rows.push(row);
    }
    return rows;
  }

  const ROWS = buildRows();

  const META = {
    line: LINE_ID,
    machines: MACHINES,
    days: DAYS,
    hours: HOURS,
    anchorNow: ANCHOR_NOW.toISOString(),
    start: START.toISOString(),
    baseline: BASE,
    // Expose injected events for the eval harness and the "show the data" panel.
    // In a real deployment these would be discovered, not known. They are
    // exposed here only so the eval set can assert the analysis layer found them.
    injectedEvents: EVENTS.map(function (e) {
      const startTs = new Date(START.getTime() + e.startHour * 3600 * 1000);
      const endTs = new Date(
        START.getTime() + (e.startHour + e.durationH) * 3600 * 1000
      );
      return {
        id: e.id,
        label: e.label,
        machine: e.machine,
        signature: e.signature,
        startTimestamp: startTs.toISOString(),
        endTimestamp: endTs.toISOString(),
        durationH: e.durationH
      };
    }),
    sensorUnits: {
      throughput: 'units/h',
      scrapRate: '%',
      injectionTempC: 'deg C',
      holdPressureBar: 'bar',
      cycleTimeS: 's'
    },
    isSynthetic: true
  };

  global.FactoryData = {
    rows: ROWS,
    meta: META
  };
})(typeof window !== 'undefined' ? window : globalThis);
