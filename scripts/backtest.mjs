/**
 * Replay past seasons through model.js exactly the way production runs it, and score the result.
 *
 * Production (functions/api/data.js) replays LAST season once to get each club's closing rating,
 * then runs this season on top of it. This does the same, one season at a time, so a number printed
 * here is a number the live site would have produced. Every model change should be judged on this
 * output - it is how SHOW_DIV and the carry-over were chosen, and without it in the repo that method
 * has already been lost once.
 *
 * Metrics:
 *   bits  - the Monash probabilistic comp's score, 1 + log2(p given to the winner), clamped at
 *           0.01/0.99 like scripts/submit-monash.mjs. The thing the comp ranks on.
 *   acc   - share of decisive games tipped correctly (draws excluded, as everywhere else here).
 *   mae   - mean absolute error of the predicted margin, which Squiggle ranks models on.
 *
 * Usage: node scripts/backtest.mjs [--from 2022] [--to 2026] [--model path/to/model.js]
 * Squiggle responses are cached in .cache/squiggle so repeat runs cost the API nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'squiggle');
const UA = 'Cludestradamus/1.0 (+https://afl-oracle.pages.dev)';
const CLAMP = 0.01;

/** One Squiggle query, cached on disk. Past seasons never change, so the cache never expires. */
export async function squiggle(q, year) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${q}-${year}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))[q];
  const r = await fetch(`https://api.squiggle.com.au/?q=${q};year=${year}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`squiggle ${q} ${year} -> ${r.status}`);
  const body = await r.json();
  // only cache a season that is over, or the current one freezes mid-year
  if (year < new Date().getFullYear()) fs.writeFileSync(file, JSON.stringify(body));
  return body[q];
}

/** Everything needed to replay `year` the production way: this season, last season, two ladders back. */
export async function loadSeason(year) {
  const [games, standings, gamesPrev, standingsPrev, standingsPrev2] = await Promise.all([
    squiggle('games', year), squiggle('standings', year),
    squiggle('games', year - 1), squiggle('standings', year - 1), squiggle('standings', year - 2),
  ]);
  return { year, games, standings, gamesPrev, standingsPrev, standingsPrev2 };
}

/** Predict every completed decisive game of a season. Mirrors data.js + tips.js. */
export function replay(model, s) {
  const eloPrev = s.gamesPrev.length
    ? model.runModel({ games: s.gamesPrev, standings: s.standingsPrev, standingsPrev: s.standingsPrev2 }).elo
    : {};
  const { PRED } = model.runModel({ games: s.games, standings: s.standings, standingsPrev: s.standingsPrev, eloPrev });
  const out = [];
  for (const g of s.games) {
    if (g.complete !== 100 || g.winnerteamid == null || g.winnerteamid === 0) continue;
    const p = PRED[g.id];
    if (!p) continue;
    const homeWon = g.winnerteamid === g.hteamid;
    out.push({
      year: s.year, round: g.round, gameid: g.id,
      pHome: p.pHome,
      pWinner: homeWon ? p.pHome : 1 - p.pHome,
      correct: p.pickId === g.winnerteamid,
      hmargin: p.homePick ? p.margin : -p.margin,
      actual: g.hscore - g.ascore,
    });
  }
  return out;
}

const bit = (p) => 1 + Math.log2(Math.min(1 - CLAMP, Math.max(CLAMP, p)));
export function score(recs) {
  const n = recs.length;
  return {
    n,
    bits: recs.reduce((s, r) => s + bit(r.pWinner), 0) / n,
    acc: recs.filter((r) => r.correct).length / n,
    mae: recs.reduce((s, r) => s + Math.abs(r.hmargin - r.actual), 0) / n,
  };
}

async function main() {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
  const from = Number(arg('--from', 2022));
  const to = Number(arg('--to', new Date().getFullYear()));
  const modelPath = path.resolve(arg('--model', path.join(ROOT, 'model.js')));
  const model = await import(pathToFileURL(modelPath).href);

  const all = [];
  console.log(`model: ${path.relative(ROOT, modelPath) || modelPath}\n`);
  console.log('season  games   bits/game  accuracy   margin MAE');
  for (let y = from; y <= to; y++) {
    const recs = replay(model, await loadSeason(y));
    if (!recs.length) continue;
    const s = score(recs);
    all.push(...recs);
    console.log(`${y}    ${String(s.n).padStart(5)}   ${s.bits.toFixed(4)}     ${(s.acc * 100).toFixed(1)}%      ${s.mae.toFixed(2)}`);
  }
  const t = score(all);
  console.log(`pooled  ${String(t.n).padStart(5)}   ${t.bits.toFixed(4)}     ${(t.acc * 100).toFixed(1)}%      ${t.mae.toFixed(2)}`);

  console.log('\ncalibration - when the model says X on the side it tips, how often does that side win?');
  for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
    const b = all.filter((r) => { const c = Math.max(r.pHome, 1 - r.pHome); return c >= lo && c < hi; });
    if (!b.length) continue;
    const said = b.reduce((s, r) => s + Math.max(r.pHome, 1 - r.pHome), 0) / b.length;
    console.log(`  says ${said.toFixed(3)} -> right ${(b.filter((r) => r.correct).length / b.length * 100).toFixed(1)}%   (n=${b.length})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
