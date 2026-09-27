/**
 * Did last round's tips actually land? Read the public Monash ladder and check.
 *
 * At the top of the Monash probabilistic comp the season is decided by about 0.2 bits (0.001 a game
 * over ~215 games), while one missed game costs roughly 0.26 - so a single silent "No Tip" can cost
 * the season. The submitter only knows the form came back without an error; the ladder is the
 * independent record of what was actually scored, and it is public, so no login is needed.
 *
 * It also measures what submitting mid-week costs: for each game it compares the value Monash
 * recorded for us with what the same blend would have given on the models' and market's FINAL
 * pre-game tips (Squiggle's archive), in bits.
 *
 *   node scripts/check-ladder.mjs              the two most recent rounds Monash has scored
 *   node scripts/check-ladder.mjs --round 26   a specific round
 *
 * Two rounds by default because Monash usually, not always, scores a round by Tuesday: checking
 * only the newest would let a round that was still unscored on check day slip through for good.
 * Exits 1 if we are missing from a ladder or any game shows "No Tip", 0 otherwise.
 */

import { pathToFileURL } from 'node:url';
import { key } from './submit-monash.mjs';
import { blend, sourcesFor, MARKET_SOURCE } from '../comp.js';

const UA = 'Cludestradamus/1.0 (+https://afl-oracle.pages.dev)';
const LADDER = 'https://probabilistic-footy.monash.edu/~footy/ladder/ladder.info.';
const NAME = process.env.MONASH_LADDER_NAME || 'Cludestradamus';
const C = 0.01;
const bit = (p) => 1 + Math.log2(Math.min(1 - C, Math.max(C, p)));

async function get(url, json) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return json ? r.json() : r.text();
}

const cells = (row) => row.replace(/<[^>]*>/g, '|').replace(/&nbsp;/g, ' ').split('|').map((x) => x.trim()).filter(Boolean);

/**
 * Parse one round's ladder into the games (as the header names them) and our row's per-game
 * entries: { p, score } for a tip, { noTip: true } for a miss. `p` is Monash's home-team probability.
 */
export function parseLadder(html, name) {
  const rows = html.split(/<TR[^>]*>/i);
  const hdr = cells(rows[1] || '');
  const stop = hdr.findIndex((x) => x === 'This' || x === 'TOTAL');
  const names = stop === -1 ? hdr : hdr.slice(0, stop);
  const games = [];
  for (let i = 0; i + 1 < names.length; i += 2) games.push({ home: names[i], away: names[i + 1] });

  for (const row of rows) {
    const c = cells(row);
    if (c.length < 4 || !/^\d+\.?$/.test(c[0]) || c[1].toLowerCase() !== name.toLowerCase()) continue;
    const twd = c.findIndex((x) => /^\d+-\d+-\d+$/.test(x));
    const entries = [];
    for (let i = 3; i < (twd === -1 ? c.length : twd - 2) && entries.length < games.length; i++) {
      const m = c[i].match(/^\(([\d.]+)\)$/);
      if (m && /^-?[\d.]+$/.test(c[i + 1] || '')) { entries.push({ p: parseFloat(m[1]), score: parseFloat(c[i + 1]) }); i++; continue; }
      if (c[i] === '(' && c[i + 1] === 'No Tip' && c[i + 2] === ')') { entries.push({ noTip: true }); i += 3; }
    }
    return { games, entries };
  }
  return { games, entries: null };
}

async function main() {
  const i = process.argv.indexOf('--round');
  const data = await get('https://afl-oracle.pages.dev/api/data', true);
  if (!data || data.error) throw new Error('could not load /api/data: ' + (data && data.error));

  let rounds;
  if (i !== -1) rounds = [Number(process.argv[i + 1])];
  else {
    const done = {};
    for (const g of data.games) (done[g.round] ||= []).push(g.complete === 100);
    rounds = Object.entries(done).filter(([, f]) => f.every(Boolean)).map(([r]) => Number(r)).sort((a, b) => b - a);
    if (!rounds.length) { console.log(`no round of ${data.year} has finished yet - nothing to check`); return; }
  }

  let checked = 0, failed = 0;
  for (const round of rounds) {
    if (checked === (i !== -1 ? 1 : 2)) break;
    const html = await get(LADDER + round + '.shtml', false);
    if (!html) { console.log(`Monash has not scored round ${round} yet`); continue; }
    checked++;
    if (!(await checkRound(data, round, html))) failed++;
    console.log('');
  }
  if (failed) process.exit(1);
}

/** Check one scored round; returns false if anything was missed. */
async function checkRound(data, round, html) {
  const year = data.year;
  const { games, entries } = parseLadder(html, NAME);
  if (!entries) {
    console.error(`FAIL: "${NAME}" is not on the round ${round} ladder at all - nothing we sent was scored`);
    return false;
  }

  // Squiggle's final pre-game tips for the round, to price the mid-week timing
  const tips = (await get(`https://api.squiggle.com.au/?q=tips;year=${year};round=${round}`, true))?.tips || [];
  const sq = data.games.filter((g) => g.round === round && g.complete === 100);
  const { names } = sourcesFor(year);

  let missed = 0, recorded = 0, atBounce = 0, priced = 0;
  console.log(`round ${round} of ${year}, as scored by Monash for ${NAME}:`);
  games.forEach((g, j) => {
    const e = entries[j];
    const label = `${g.home} v ${g.away}`;
    if (!e || e.noTip) { missed++; console.log(`  NO TIP   ${label}`); return; }
    // what the blend would have said on the final pre-game tips, from Monash's home side's view
    const h = key(g.home), a = key(g.away);
    const game = sq.find((x) => (key(x.hteam) === h && key(x.ateam) === a) || (key(x.hteam) === a && key(x.ateam) === h));
    let note = '';
    if (game) {
      const st = {};
      for (const t of tips) if (t.gameid === game.id && t.hconfidence != null) st[t.source] = parseFloat(t.hconfidence) / 100;
      const models = names.map((s) => st[s]).filter((v) => v != null);
      const b = blend(st[MARKET_SOURCE] ?? null, models, null);
      if (b.p != null) {
        const flipped = key(game.hteam) !== h;
        const pFinal = flipped ? 1 - b.p : b.p;
        const homeWon = (game.winnerteamid === game.hteamid) !== flipped;
        const mine = bit(homeWon ? e.p : 1 - e.p), fin = bit(homeWon ? pFinal : 1 - pFinal);
        recorded += mine; atBounce += fin; priced++;
        note = `   final-tips blend ${pFinal.toFixed(2)} would have scored ${fin.toFixed(3)}`;
      }
    }
    console.log(`  ok       ${label}: we had ${e.p.toFixed(2)}, scored ${e.score.toFixed(3)}${note}`);
  });
  if (priced) {
    const d = (atBounce - recorded) / priced;
    console.log(`timing: submitting mid-week ${d >= 0 ? 'cost' : 'gained'} ${Math.abs(d).toFixed(3)} bits/game this round against the blend on final tips (${priced} games)`);
  }
  if (missed) {
    console.error(`FAIL: ${missed} game(s) in round ${round} scored "No Tip" - each one costs about 0.26 bits against the field`);
    return false;
  }
  console.log(`all ${games.length} games carry our tip`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
