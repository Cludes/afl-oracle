/**
 * Cloudflare Pages Function - GET /api/tips
 *
 * Machine-readable tips for the current round, computed on demand from live data with the same
 * model.js the site uses (so the published tips can never drift from what the site shows). This is
 * the endpoint a puller like Squiggle can crawl, and the source a submission bot reads.
 *
 * Each tip carries: gameid, teams, the team we tip to win, our home-win probability (hconfidence,
 * 0-100, the Squiggle convention), and the predicted margin from the home team's perspective (hmargin).
 * Optional ?round=N returns a specific round instead of the next one.
 */

import { runModel } from '../../model.js';

export async function onRequestOptions() { return cors(new Response(null, { status: 204 })); }

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  let data;
  try {
    data = await (await fetch(origin + '/api/data', { headers: { 'Accept': 'application/json' } })).json();
  } catch (e) {
    return cors(json({ error: 'upstream /api/data failed: ' + String(e) }, 502));
  }
  if (!data || data.error) return cors(json({ error: (data && data.error) || 'no data' }, 502));

  const { PRED } = runModel(data);
  const TEAM = {};
  for (const g of data.games) { TEAM[g.hteamid] = g.hteam; TEAM[g.ateamid] = g.ateam; }

  const qRound = new URL(context.request.url).searchParams.get('round');
  const round = qRound != null ? Number(qRound) : data.nextRound;

  const games = data.games
    .filter((g) => g.round === round && g.hteamid && g.ateamid)
    .sort((a, b) => (a.unixtime || 0) - (b.unixtime || 0));

  const tips = games.map((g) => {
    const p = PRED[g.id];
    const hmargin = p.homePick ? p.margin : -p.margin; // predicted margin, home-team perspective
    return {
      gameid: g.id,
      round: g.round,
      date: g.date,
      venue: g.venue,
      hteam: g.hteam,
      ateam: g.ateam,
      tip: TEAM[p.pickId],                         // team we tip to win
      hconfidence: Math.round(p.pHome * 100),      // % chance the HOME team wins
      confidence: p.conf,                          // % chance our tipped team wins
      hmargin,                                     // predicted margin (home perspective, may be negative)
      margin: p.margin,                            // predicted margin for our tipped team (always positive)
    };
  });

  const resp = json({ source: 'Cludestradamus', generated: new Date().toISOString(), year: data.year, round, tips });
  resp.headers.set('Cache-Control', 'public, max-age=600');
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
