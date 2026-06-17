# How I built FactoryWaste Copilot in a weekend

A short technical write-up of a proof-of-work demo for a Forward Deployed
Engineer role at EthonAI. The goal was not to build a product. It was to build a
small working slice of EthonAI's actual problem (eliminating waste in
manufacturing) and present it the way an FDE would on day one.

## The thesis in one line

Deterministic data work, an LLM only at the explanation layer, built for the
person on the factory floor rather than a data scientist.

## Why a Copilot, and why so narrow

EthonAI's hard problem is not the model. Modern models are strong. The hard part
is running AI in messy real-world plants and getting non-technical operators to
trust and adopt it. So I picked the smallest thing that demonstrates exactly that
tension: a plant operator asks, in plain English, why a line is wasting material,
and gets a specific answer they can verify.

Scope discipline was part of the test. I resisted building a platform. One line,
one wedge.

## The build, in four layers

### 1. Synthetic data with a known ground truth (`data.js`)

One injection-molding line, 30 days, hourly rows: throughput, scrap rate,
injection temperature, hold pressure, cycle time, across three machines. A seeded
PRNG makes it byte-for-byte reproducible.

I injected four waste events. Three share an "M-07 injection temperature drop"
signature (a recurring heater calibration issue). One is deliberately different
(an M-06 hold-pressure jam). The recurring-versus-one-off split is what lets the
analysis say "3 of the last 4 spikes share this signature", and the odd one out
is the control case that proves the correlation logic is specific rather than
blaming one machine for everything.

### 2. A deterministic analysis engine (`analysis.js`)

This is the part I care about most. No black-box model. Plain, auditable rules:

- Robust baseline scrap rate from the median of healthy hours (spikes excluded so
  they cannot pollute the baseline).
- Spike detection: hours where scrap exceeds baseline by a set margin.
- Grouping of consecutive spike hours into events.
- Root-cause attribution: for each spike, measure how far each sensor moved from
  its baseline in sigma, and attribute the cause to the strongest deviation.
- Signature clustering: count how many spikes share a cause.
- Waste quantification: extra scrapped units above baseline, per event and total.
- Ranking: recurring and costly causes first.

An operator can follow every step. That is the point. Trust on a factory floor
comes from reproducibility, not from a confident sentence.

### 3. A grounded narration layer (`copilot.js`)

The chat layer classifies the question deterministically (intent, time window,
metric), then pulls the matching facts from the analysis layer into a structured
"fact object". That fact object is the only thing the narrator may speak from.

There are two narrators behind the same interface. The default is a deterministic
template narrator that consumes only the fact object, so it is structurally
incapable of inventing a number and it runs fully offline with no key. The
optional one sends the same fact object to Claude with a hard instruction to
narrate those numbers and invent nothing, and falls back to the mock narrator on
any error. Swap the model and the answers stay correct, because correctness lives
in the data layer.

### 4. A trust UI and an eval suite (`app.js`, `evals.js`)

The UI shows the answer plus a "show the data behind this" panel: the computed
analysis, a scrap-rate chart with the spike and baseline marked, and the raw
hourly rows. The operator verifies rather than believes. Adoption is the product.

The eval suite is 10 question/expected-fact pairs. Critically, the assertions are
on the structured facts, not the prose, so they survive rewording and actually
prove the system is honest. A green run means the Copilot cannot state a wrong
number. It runs in the UI and headless (`npm run eval`), and it currently passes
10/10.

## What I would do next with real constraints

- Replace synthetic data with a connector to the customer's historian (OPC UA /
  MQTT / SQL), keeping the same deterministic contract downstream.
- Let an engineer tune detection thresholds in the UI and version those configs.
- Add a feedback loop: when an operator confirms or rejects a root cause, log it
  to refine attribution and to build the trust record that drives adoption.
- Expand from one line to a plant, with the same "every number traces to the
  data" discipline.

## Honest framing

This is synthetic data and a weekend of work, not a product, and it is not
connected to any EthonAI or customer data. It does not solve the real problem. It
proves I can build toward it, the way a Forward Deployed Engineer does: ship the
wedge, ground every claim, and build for the person who has to use it.
