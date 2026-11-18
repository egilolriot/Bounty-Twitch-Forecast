// Bounty-Twitch-Forecast entry (competition gta6-twitch-ccu-forecast-01).
// Node 22, standard library only. Reads every <id>.in in the input
// directory and writes one <id>.out forecast per case to the output
// directory. Offline and deterministic: the same input always produces
// the same bytes.
//
// The forecast: for each hour h = 2..24 of the release day, five
// quantiles of that hour's Twitch concurrent-viewer count at the levels
// 0.05, 0.25, 0.5, 0.75 and 0.95, written as
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}
// exactly 23 rows, each q non-decreasing, finite, above 0 and at most
// 1e9, file at most 65,536 bytes.
//
// The model: a rolling-midnight median curve. GTA VI unlocks at local
// midnight, rolling country by country, so its closest analogues are past
// launches that unlocked the same way — not simultaneous-global launches
// (whose hour 1 is near-zero pre-unlock noise) and not early-access
// launches (whose peak already happened days before release day). Each
// case's own comparables are filtered at runtime to that set, the median
// ratio viewers(h)/viewers(1) per hour is taken, the spread comes from
// the interquartile range of the log ratios, and a scale adjustment
// shrinks the evening rise when hour 1 is already huge (a big hour 1
// means most of the world is already watching). If fewer than five
// comparables survive the filter, a hardcoded fallback curve fitted on
// the practice set is used instead. See README.md for the full write-up.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at LEVELS. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Largest viewer count an output quantile may hold. */
const MAX_VIEWERS = 1e9;
/** Largest output file size in bytes. */
const MAX_BYTES = 65536;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface ForecastRow {
  hour: number;
}

interface CaseFile {
  id: string;
  levels: number[];
  known: KnownRow[];
  forecast: ForecastRow[];
  history?: unknown;
  history_hourly?: unknown;
  streams?: unknown;
  categories_hourly?: unknown;
  comparables?: unknown;
  notes?: unknown;
}

/** Everything the model may use, beyond hour 1's print and the hour. */
interface ModelContext {
  caseId: string;
  levels: number[];
  raw: CaseFile;
  /** Fitted curve, one entry per hour 2..24 (index hour - 2). */
  curve: CurvePoint[];
}

/** One fitted point of the ratio curve: median ratio and log spread. */
interface CurvePoint {
  ratio: number;
  spread: number;
}

/** One comparable launch, as it arrives in a case file. */
interface Comparable {
  name?: unknown;
  day_start?: unknown;
  unlock?: unknown;
  hourly?: Array<{ from?: unknown; viewers?: unknown }>;
}

/** A comparable that passed the filter: hour-1 print + log ratios. */
interface KeptGame {
  v1: number;
  /** log(viewers(h) / v1) for h = 2..24, in order. */
  logRatio: number[];
}

/** Median hour-1 print of the practice rolling set, for the fallback path. */
const FALLBACK_P_REF = 122182;

/**
 * Fallback curve (practice-set fit, rolling n = 10), used only when
 * fewer than 5 comparables pass the filter. r = median ratio,
 * s = log spread (already floored at 0.20), b = full OLS scale beta
 * (applied at half strength, as in the runtime fit).
 */
const FALLBACK: Record<number, { r: number; s: number; b: number }> = {
  2: { r: 0.882, s: 0.200, b: 0.07 },
  3: { r: 0.775, s: 0.206, b: 0.17 },
  4: { r: 0.786, s: 0.322, b: 0.05 },
  5: { r: 0.829, s: 0.218, b: -0.06 },
  6: { r: 1.05, s: 0.228, b: -0.21 },
  7: { r: 1.081, s: 0.2, b: -0.3 },
  8: { r: 1.107, s: 0.2, b: -0.35 },
  9: { r: 1.056, s: 0.293, b: -0.39 },
  10: { r: 1.105, s: 0.328, b: -0.4 },
  11: { r: 1.102, s: 0.312, b: -0.4 },
  12: { r: 1.088, s: 0.341, b: -0.4 },
  13: { r: 1.216, s: 0.432, b: -0.41 },
  14: { r: 1.398, s: 0.5, b: -0.42 },
  15: { r: 1.589, s: 0.507, b: -0.41 },
  16: { r: 1.842, s: 0.518, b: -0.39 },
  17: { r: 1.999, s: 0.509, b: -0.37 },
  18: { r: 2.172, s: 0.476, b: -0.41 },
  19: { r: 2.472, s: 0.449, b: -0.44 },
  20: { r: 2.391, s: 0.385, b: -0.47 },
  21: { r: 2.362, s: 0.27, b: -0.48 },
  22: { r: 2.315, s: 0.282, b: -0.49 },
  23: { r: 2.207, s: 0.298, b: -0.49 },
  24: { r: 1.992, s: 0.441, b: -0.53 },
};

/** x rounded to 2 decimals, half up. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Median of a non-empty list. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** q-th quantile of an ascending-sorted list, linear interpolation. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Ordinary-least-squares slope of ys on xs; 0 when xs has no spread. */
function olsSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/** Phrases in an unlock note that disqualify a comparable outright. */
const EXCLUDED_PHRASES = [
  'early-access-contaminated',
  'single global',
  'simultaneous global',
  'simultaneous across',
  'single simultaneous',
  'not a launch',
];

/**
 * True when a comparable's unlock note describes a rolling-midnight
 * launch and carries none of the disqualifying phrases. Deliberately
 * narrow: bare "early access" does not exclude (several good analogues
 * mention a campaign early-access period), and bare "simultaneous"
 * does not exclude either (a midnight unlock in one zone can still be
 * described that way) — only the explicit tags above do.
 */
function isRollingMidnight(unlock: string): boolean {
  const u = unlock.toLowerCase();
  if (!u.includes('midnight local') && !u.includes('rolling')) return false;
  return !EXCLUDED_PHRASES.some((phrase) => u.includes(phrase));
}

/**
 * A comparable's release-day viewer counts, keyed by hour 1..24.
 * Hour h is the point whose `from` timestamp equals
 * day_start + (h - 1) hours, matched by timestamp, never by array
 * position — some comparables are sparse and have gaps elsewhere.
 * Returns null when day_start is unusable.
 */
function releaseDayHours(comp: Comparable): Map<number, number> | null {
  if (typeof comp.day_start !== 'string') return null;
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const byTime = new Map<number, number>();
  for (const pt of comp.hourly ?? []) {
    if (typeof pt?.from !== 'string' || typeof pt?.viewers !== 'number') continue;
    const t = Date.parse(pt.from);
    if (Number.isFinite(t) && pt.viewers >= 0) byTime.set(t, pt.viewers);
  }
  const byHour = new Map<number, number>();
  for (let h = 1; h <= 24; h++) {
    const v = byTime.get(start + (h - 1) * 3600000);
    if (v !== undefined) byHour.set(h, v);
  }
  return byHour;
}

/**
 * Keep the comparables that are valid rolling-midnight analogues:
 * the keyword rule above, plus a data guard — all 24 release-day
 * hours present, hour 1 at least 1,000 viewers and at least 2% of
 * the day's peak (which drops near-zero hour-1 launches and the
 * GTA VI target-history entry, which is not a launch at all).
 */
function selectComparables(raw: unknown): KeptGame[] {
  if (!Array.isArray(raw)) return [];
  const kept: KeptGame[] = [];
  for (const comp of raw as Comparable[]) {
    if (typeof comp?.unlock !== 'string' || !isRollingMidnight(comp.unlock)) continue;
    const day = releaseDayHours(comp);
    if (!day) continue;
    const v1 = day.get(1);
    if (v1 === undefined) continue;
    let peak = 0;
    let complete = true;
    for (let h = 1; h <= 24; h++) {
      const v = day.get(h);
      if (v === undefined) {
        complete = false;
        break;
      }
      if (v > peak) peak = v;
    }
    if (!complete) continue;
    if (v1 < 1000 || v1 < 0.02 * peak) continue;
    const logRatio: number[] = [];
    for (let h = 2; h <= 24; h++) logRatio.push(Math.log(day.get(h)! / v1));
    kept.push({ v1, logRatio });
  }
  return kept;
}

/**
 * Fit the ratio curve from the kept comparables. Per hour h = 2..24:
 * r_h is the median ratio to hour 1, s_h the interquartile range of
 * the log ratios divided by 1.349 (a robust normal-scale estimate),
 * floored at 0.20. A scale adjustment then shrinks the curve when
 * this case's hour 1 is large relative to the kept set's median
 * hour 1: b_h is the OLS slope of log r_h on log v1 across the kept
 * games, applied at half strength, with the factor clamped to
 * [0.45, 1.6]. The slope is deliberately NOT clamped to a narrow
 * band: the fitted evening betas run to about -0.53, and capping
 * them at -0.30 would throw away most of the adjustment the practice
 * cases validate (practice loss 0.206 with a -0.30 cap, 0.189
 * without; the fallback table's own betas reach -0.53). Half
 * strength plus the factor clamp is the extrapolation guard.
 * With fewer than 5 kept games the hardcoded fallback curve is
 * used, with the same half-strength adjustment against the
 * fallback reference hour 1.
 */
function fitCurve(p: number, kept: KeptGame[]): CurvePoint[] {
  const curve: CurvePoint[] = [];
  if (kept.length >= 5) {
    const logV1 = kept.map((g) => Math.log(g.v1));
    const pRef = median(kept.map((g) => g.v1));
    for (let h = 2; h <= 24; h++) {
      const j = h - 2;
      const logs = kept.map((g) => g.logRatio[j]);
      const sorted = [...logs].sort((a, b) => a - b);
      const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25);
      const spread = Math.max(iqr / 1.349, 0.2);
      const beta = olsSlope(logV1, logs);
      const factor = Math.min(1.6, Math.max(0.45, Math.pow(p / pRef, 0.5 * beta)));
      curve.push({ ratio: Math.exp(median(logs)) * factor, spread });
    }
  } else {
    for (let h = 2; h <= 24; h++) {
      const fb = FALLBACK[h];
      const factor = Math.min(1.6, Math.max(0.45, Math.pow(p / FALLBACK_P_REF, 0.5 * fb.b)));
      curve.push({ ratio: fb.r * factor, spread: fb.s });
    }
  }
  return curve;
}

/**
 * The model's five quantiles for one hour:
 * q_tau = p * r'_h * exp(z_tau * s_h), where r'_h is the fitted
 * scale-adjusted median ratio and s_h the fitted log spread.
 */
function forecastHour(p: number, hour: number, ctx: ModelContext): number[] {
  const point = ctx.curve[hour - 2];
  if (!point) throw new Error(`case ${ctx.caseId}: no fitted curve for hour ${hour}`);
  return Z.map((z) => round2(p * point.ratio * Math.exp(z * point.spread)));
}

/** Clamp a raw quantile into the legal range and keep the row ordered. */
function cleanQuantiles(raw: number[]): number[] {
  const qs = raw.map((v) => {
    if (!Number.isFinite(v)) return 1;
    return Math.min(MAX_VIEWERS, Math.max(1, v));
  });
  for (let j = 1; j < qs.length; j++) {
    if (qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
  }
  return qs;
}

/** Check one finished forecast object against the contest's shape rules. */
function validateForecast(hours: Array<{ hour: number; q: number[] }>): void {
  if (hours.length !== 23) throw new Error(`forecast has ${hours.length} rows, need 23`);
  const seen = new Set<number>();
  for (const row of hours) {
    if (seen.has(row.hour)) throw new Error(`hour ${row.hour} forecast twice`);
    seen.add(row.hour);
    if (row.q.length !== LEVELS.length) throw new Error(`hour ${row.hour}: ${row.q.length} quantiles, need ${LEVELS.length}`);
    for (let j = 0; j < row.q.length; j++) {
      const v = row.q[j];
      if (!Number.isFinite(v) || v <= 0 || v > MAX_VIEWERS) throw new Error(`hour ${row.hour}: quantile ${v} out of range`);
      if (j > 0 && v < row.q[j - 1]) throw new Error(`hour ${row.hour}: quantiles not non-decreasing`);
    }
  }
  for (let h = 2; h <= 24; h++) {
    if (!seen.has(h)) throw new Error(`hour ${h} missing from forecast`);
  }
}

function forecastCase(c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case ${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`case ${c.id} has no hour-1 print`);
  const p = Math.max(1, first.viewers);
  const curve = fitCurve(p, selectComparables(c.comparables));
  const ctx: ModelContext = { caseId: c.id, levels: c.levels, raw: c, curve };
  const hours = c.forecast.map(({ hour }) => ({
    hour,
    q: cleanQuantiles(forecastHour(p, hour, ctx)),
  }));
  validateForecast(hours);
  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    const out = forecastCase(c);
    const text = `${JSON.stringify(out)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      throw new Error(`case ${id}: output ${Buffer.byteLength(text, 'utf8')} bytes, over ${MAX_BYTES}`);
    }
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), text);
  }
}

main();
