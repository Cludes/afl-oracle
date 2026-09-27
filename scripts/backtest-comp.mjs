/**
 * Score the Monash entry (comp.js) against the Elo, season by season, and pick next season's models.
 *
 * For each season Y the models are chosen the way they will be live: the 10 best by bits/game over
 * season Y-1, never Y itself. Squiggle's archive holds each model's FINAL pre-game tip, while the live
 * entry is submitted during the week, so treat these numbers as an upper bound on the live result.
 *
 *   node scripts/backtest-comp.mjs                     score 2022..now
 *   node scripts/backtest-comp.mjs --sources-for 2028  print the model list to put in comp.js
 *
 * MARKET_WEIGHT and SHARPEN were chosen on 2022-2026 (the optimum is flat); leave-one-season-out the
 * blend scored 0.2012 bits/game against the Elo's 0.1773.
 */

import { pathToFileURL } from 'node:url';
import { squiggle, loadSeason, replay } from './backtest.mjs';
import * as M from '../model.js';
import { blend, EXCLUDE, MARKET_SOURCE } from '../comp.js';

const K = 10;
const C = 0.01;
const bit = (p) => 1 + Math.log2(Math.min(1 - C, Math.max(C, p)));

async function seasonTips(year) {
  const [tips, games] = await Promise.all([squiggle('tips', year), squiggle('games', year)]);
  const homeWon = {};
  for (const g of games) if (g.complete === 100 && g.winnerteamid) homeWon[g.id] = g.winnerteamid === g.hteamid;
  const bySource = {};   // source -> gameid -> home-win probability
  for (const t of tips) {
    if (t.hconfidence == null || homeWon[t.gameid] == null) continue;
    (bySource[t.source] ||= {})[t.gameid] = parseFloat(t.hconfidence) / 100;
  }
  return { bySource, homeWon, decisive: Object.keys(homeWon).length };
}

/** The K best models of `year` by bits/game, among those that tipped 90%+ of its decisive games. */
export async function bestModels(year, k = K) {
  const { bySource, homeWon, decisive } = await seasonTips(year);
  return Object.entries(bySource)
    .filter(([s, m]) => !EXCLUDE.includes(s) && Object.keys(m).length >= 0.9 * decisive)
    .map(([s, m]) => {
      const ids = Object.keys(m);
      return [s, ids.reduce((a, id) => a + bit(homeWon[id] ? m[id] : 1 - m[id]), 0) / ids.length];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
}

async function main() {
  const i = process.argv.indexOf('--sources-for');
  if (i !== -1) {
    const year = Number(process.argv[i + 1]);
    const best = await bestModels(year - 1);
    console.log(`The ${K} best Squiggle models of ${year - 1} (bits/game), for SOURCES_BY_SEASON[${year}] in comp.js:\n`);
    for (const [s, b] of best) console.log(`  ${b.toFixed(4)}  ${s}`);
    console.log('\n  ' + JSON.stringify(best.map(([s]) => s)));
    return;
  }

  console.log('season   elo bits   entry bits   entry acc   games with a market price');
  let tot = { elo: 0, entry: 0, n: 0 };
  for (let y = 2022; y <= new Date().getFullYear(); y++) {
    const names = (await bestModels(y - 1)).map(([s]) => s);
    const { bySource } = await seasonTips(y);
    const recs = replay(M, await loadSeason(y));
    if (!recs.length) continue;
    let e = 0, b = 0, right = 0, priced = 0;
    for (const r of recs) {
      const homeWon = r.actual > 0;
      const market = bySource[MARKET_SOURCE]?.[r.gameid] ?? null;
      const models = names.map((s) => bySource[s]?.[r.gameid]).filter((p) => p != null);
      const { p } = blend(market, models, r.pHome);
      e += bit(r.pWinner); b += bit(homeWon ? p : 1 - p);
      if ((p >= 0.5) === homeWon) right++;
      if (market != null) priced++;
    }
    const n = recs.length;
    tot.elo += e; tot.entry += b; tot.n += n;
    console.log(`${y}     ${(e / n).toFixed(4)}     ${(b / n).toFixed(4)}       ${(right / n * 100).toFixed(1)}%       ${priced}/${n}`);
  }
  console.log(`pooled   ${(tot.elo / tot.n).toFixed(4)}     ${(tot.entry / tot.n).toFixed(4)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
