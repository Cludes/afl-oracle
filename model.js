'use strict';

// Cludestradamus AFL model - the single source of truth for the site and the tips endpoint,
// so what the site shows and what we submit to a comp can never drift apart.
// Pure and dependency-free: runs unchanged in the browser, a Cloudflare Pages Function, and Node.
//
// Travel-aware home-ground advantage, tuned by leave-one-season-out backtest on 2021-2026.
// A flat HGA treats a Perth road trip like a cross-town derby; interstate travel is the single
// biggest AFL-specific factor, so the edge grows with how far the away side had to travel.

export const HGA_BASE = 20;   // base home edge (same-state game)
export const HGA_TRAVEL = 10; // extra when the away team is playing interstate
export const HGA_WEST = 30;   // extra again when the trip crosses to/from WA (the long haul)
export const K = 10;          // Elo update factor (lower = steadier ratings)
export const MARGIN_DIV = 5;  // Elo diff -> predicted margin
export const PRIOR_SCALE = 5; // pre-season prior spread from last year's ladder

export const VENUE_STATE = {
  'M.C.G.': 'VIC', 'Docklands': 'VIC', 'Kardinia Park': 'VIC', 'Eureka Stadium': 'VIC',
  'Adelaide Oval': 'SA', 'Norwood Oval': 'SA', 'Barossa Park': 'SA', 'Adelaide Hills': 'SA',
  'Perth Stadium': 'WA', 'Hands Oval': 'WA',
  'Gabba': 'QLD', 'Carrara': 'QLD', "Cazaly's Stadium": 'QLD',
  'S.C.G.': 'NSW', 'Sydney Showground': 'NSW', 'Stadium Australia': 'NSW', 'Manuka Oval': 'ACT',
  'York Park': 'TAS', 'Bellerive Oval': 'TAS', 'Marrara Oval': 'NT', 'Traeger Park': 'NT',
};
export const TEAM_STATE = {
  'Adelaide': 'SA', 'Brisbane Lions': 'QLD', 'Carlton': 'VIC', 'Collingwood': 'VIC',
  'Essendon': 'VIC', 'Fremantle': 'WA', 'Geelong': 'VIC', 'Gold Coast': 'QLD',
  'Greater Western Sydney': 'NSW', 'Hawthorn': 'VIC', 'Melbourne': 'VIC', 'North Melbourne': 'VIC',
  'Port Adelaide': 'SA', 'Richmond': 'VIC', 'St Kilda': 'VIC', 'Sydney': 'NSW',
  'West Coast': 'WA', 'Western Bulldogs': 'VIC',
};

// effective home-ground advantage for a game, accounting for interstate travel
export function hgaFor(g) {
  const vs = VENUE_STATE[g.venue];
  if (!vs) return HGA_BASE; // unknown venue -> fall back to base edge
  const hs = TEAM_STATE[g.hteam], as = TEAM_STATE[g.ateam];
  let h = HGA_BASE;
  const awayInterstate = as && vs !== as;
  const homeInterstate = hs && vs !== hs;
  if (awayInterstate) h += HGA_TRAVEL + (vs === 'WA' || as === 'WA' ? HGA_WEST : 0);
  else if (homeInterstate) h -= HGA_TRAVEL; // home side is the one that travelled (neutral/away venue)
  return h;
}

const expHome = (eH, eA, H) => 1 / (1 + Math.pow(10, -((eH + H - eA) / 400)));

// Build ratings and per-game predictions from the /api/data payload (games, standings, standingsPrev).
// Returns { elo, TEAM, RANK, FORM, PRED, OUR }. PRED[gameId] carries pickId, pHome (raw home-win
// probability), conf, margin, eloDiff, homePick, and (for completed games) right.
export function runModel(data) {
  const elo = {};
  const getElo = (id) => (id in elo ? elo[id] : 1500);
  const TEAM = {}, RANK = {}, FORM = {}, PRED = {};
  const OUR = { correct: 0, total: 0 };

  for (const t of (data.standings || [])) { TEAM[t.id] = t.name; RANK[t.id] = t.rank; }
  for (const g of (data.games || [])) { TEAM[g.hteamid] = g.hteam; TEAM[g.ateamid] = g.ateam; }
  // pre-season prior: seed Elo from last year's final ladder so early-round picks aren't coin-flips
  for (const t of (data.standingsPrev || [])) elo[t.id] = 1500 + (9.5 - t.rank) * PRIOR_SCALE;

  const sorted = [...(data.games || [])].filter((g) => g.hteamid && g.ateamid).sort((a, b) => (a.unixtime || 0) - (b.unixtime || 0));
  for (const g of sorted) {
    const eH = getElo(g.hteamid), eA = getElo(g.ateamid);
    const H = hgaFor(g);
    const pHome = expHome(eH, eA, H);
    const homePick = pHome >= 0.5;
    PRED[g.id] = {
      pickId: homePick ? g.hteamid : g.ateamid,
      pHome,
      conf: Math.round(Math.max(pHome, 1 - pHome) * 100),
      margin: Math.max(1, Math.round(Math.abs(eH + H - eA) / MARGIN_DIV)),
      eloDiff: Math.round(Math.abs(eH + H - eA)), homePick,
    };
    if (g.complete === 100) {
      // Squiggle marks a draw with winnerteamid null (not 0) - a completed game with no winner is a
      // draw, excluded from grading (margin 0 makes it a no-op for Elo anyway).
      const draw = g.winnerteamid == null || g.winnerteamid === 0;
      if (!draw) {
        OUR.total++; const right = PRED[g.id].pickId === g.winnerteamid;
        if (right) OUR.correct++; PRED[g.id].right = right;
        (FORM[g.hteamid] = FORM[g.hteamid] || []).push(g.winnerteamid === g.hteamid);
        (FORM[g.ateamid] = FORM[g.ateamid] || []).push(g.winnerteamid === g.ateamid);
      }
      const am = g.hscore - g.ascore;
      const actualHome = draw ? 0.5 : (am > 0 ? 1 : 0);
      // 538-style margin-of-victory multiplier (damps blowouts, corrects upsets faster)
      const winnerEdge = actualHome === 1 ? (eH + H - eA) : (eA - (eH + H));
      const mov = Math.log(Math.abs(am) + 1) * (2.2 / (winnerEdge * 0.001 + 2.2));
      const ch = K * mov * (actualHome - pHome);
      elo[g.hteamid] = eH + ch; elo[g.ateamid] = eA - ch;
    }
  }
  OUR.pct = OUR.total ? (OUR.correct / OUR.total * 100) : 0;
  return { elo, TEAM, RANK, FORM, PRED, OUR };
}
