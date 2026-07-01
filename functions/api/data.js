/**
 * Cloudflare Pages Function - GET /api/data
 *
 * Proxies the keyless Squiggle API (which sends no CORS and wants a User-Agent):
 * fetches the season's games + ladder + every model's tips, tallies each expert
 * model's season accuracy, finds the next round, adds CORS, edge-caches 10min.
 */

const UA = 'afl-oracle/1.0 (+https://afl-oracle.pages.dev)';
const CACHE_TTL = 600;
// NOTE: new Date() at module top-level returns epoch (1970) in Workers - the clock is
// only available inside a request. So the season year is computed in the handler.

async function sq(q) {
  const r = await fetch(`https://api.squiggle.com.au/?q=${q}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`squiggle ${q} -> ${r.status}`);
  return r.json();
}

export async function onRequestOptions() { return cors(new Response(null, { status: 204 })); }

export async function onRequestGet(context) {
  const Y = new Date().getFullYear();   // AFL season = calendar year (computed per-request)
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/__afl_v2', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  let games, standings, tips, standingsPrev;
  try {
    const [g, s, t, sp] = await Promise.all([
      sq(`games;year=${Y}`), sq(`standings;year=${Y}`), sq(`tips;year=${Y}`),
      sq(`standings;year=${Y - 1}`).catch(() => ({ standings: [] })),
    ]);
    games = g.games || []; standings = s.standings || []; tips = t.tips || []; standingsPrev = sp.standings || [];
  } catch (e) {
    return cors(json({ error: String(e) }, 502));
  }

  // drawn games (Squiggle marks a draw as winnerteamid null) are excluded from grading for
  // everyone, so the model and the experts are compared on the identical decisive-game set
  const drawnGames = new Set(games.filter((g) => g.complete === 100 && (g.winnerteamid == null || g.winnerteamid === 0)).map((g) => g.id));

  // expert leaderboard: tally each model's correct/total/bits over graded tips
  const tally = {};
  for (const t of tips) {
    if (t.correct !== 0 && t.correct !== 1) continue;
    if (drawnGames.has(t.gameid)) continue;
    const s = t.source; if (!s) continue;
    (tally[s] = tally[s] || { source: s, correct: 0, total: 0, bits: 0 });
    tally[s].correct += t.correct; tally[s].total++; tally[s].bits += parseFloat(t.bits) || 0;
  }
  const experts = Object.values(tally);

  const incomplete = games.filter(g => g.complete !== 100);
  const nextRound = incomplete.length ? Math.min(...incomplete.map(g => g.round)) : Math.max(...games.map(g => g.round));
  const ids = new Set(games.filter(g => g.round === nextRound).map(g => g.id));
  const nextRoundTips = tips.filter(t => ids.has(t.gameid));

  const resp = json({ fetched_at: new Date().toISOString(), year: Y, games, standings, standingsPrev, experts, nextRound, nextRoundTips });
  resp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return cors(resp);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
