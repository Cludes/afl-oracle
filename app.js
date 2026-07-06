'use strict';

// Travel-aware home-ground advantage, tuned by leave-one-season-out backtest on 2021-2026.
// A flat HGA treats a Perth road trip like a cross-town derby; interstate travel is the single
// biggest AFL-specific factor, so the edge grows with how far the away side had to travel.
const HGA_BASE = 20;   // base home edge (same-state game)
const HGA_TRAVEL = 10; // extra when the away team is playing interstate
const HGA_WEST = 30;   // extra again when the trip crosses to/from WA (the long haul)
const K = 10;          // Elo update factor (lower = steadier ratings; was over-reacting at 20)
const MARGIN_DIV = 5;  // Elo diff -> predicted margin
const PRIOR_SCALE = 5; // pre-season prior spread from last year's ladder (was 14 - too strong)

const VENUE_STATE = {
  'M.C.G.': 'VIC', 'Docklands': 'VIC', 'Kardinia Park': 'VIC', 'Eureka Stadium': 'VIC',
  'Adelaide Oval': 'SA', 'Norwood Oval': 'SA', 'Barossa Park': 'SA', 'Adelaide Hills': 'SA',
  'Perth Stadium': 'WA', 'Hands Oval': 'WA',
  'Gabba': 'QLD', 'Carrara': 'QLD', "Cazaly's Stadium": 'QLD',
  'S.C.G.': 'NSW', 'Sydney Showground': 'NSW', 'Stadium Australia': 'NSW', 'Manuka Oval': 'ACT',
  'York Park': 'TAS', 'Bellerive Oval': 'TAS', 'Marrara Oval': 'NT', 'Traeger Park': 'NT',
};
const TEAM_STATE = {
  'Adelaide': 'SA', 'Brisbane Lions': 'QLD', 'Carlton': 'VIC', 'Collingwood': 'VIC',
  'Essendon': 'VIC', 'Fremantle': 'WA', 'Geelong': 'VIC', 'Gold Coast': 'QLD',
  'Greater Western Sydney': 'NSW', 'Hawthorn': 'VIC', 'Melbourne': 'VIC', 'North Melbourne': 'VIC',
  'Port Adelaide': 'SA', 'Richmond': 'VIC', 'St Kilda': 'VIC', 'Sydney': 'NSW',
  'West Coast': 'WA', 'Western Bulldogs': 'VIC',
};

// effective home-ground advantage for a game, accounting for interstate travel
function hgaFor(g) {
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

const $ = id => document.getElementById(id);
const elo = {};
const getElo = id => (id in elo ? elo[id] : 1500);
const expHome = (eH, eA, H) => 1 / (1 + Math.pow(10, -((eH + H - eA) / 400)));

let DATA = null, TEAM = {}, RANK = {}, FORM = {}, PRED = {}, OUR = { correct: 0, total: 0 };
let VIEW_ROUND = null; // round currently shown on the "This Round" tab (defaults to next round)

async function load() {
  try {
    const r = await fetch('/api/data', { cache: 'no-store' });
    DATA = await r.json();
    if (DATA.error) throw new Error(DATA.error);
    prep();
    renderTips(); renderLadder(); renderBoard();
    $('updated').textContent = 'data ' + new Date(DATA.fetched_at).toLocaleTimeString();
    setStatus('ok');
  } catch (e) { console.error(e); setStatus('err'); $('tips').innerHTML = `<div class="empty">Couldn't load the season data.</div>`; }
}

function prep() {
  for (const t of DATA.standings) { TEAM[t.id] = t.name; RANK[t.id] = t.rank; }
  for (const g of DATA.games) { TEAM[g.hteamid] = g.hteam; TEAM[g.ateamid] = g.ateam; }
  // pre-season prior: seed Elo from last year's final ladder so early-round picks aren't coin-flips
  for (const t of (DATA.standingsPrev || [])) elo[t.id] = 1500 + (9.5 - t.rank) * PRIOR_SCALE;

  const sorted = [...DATA.games].filter(g => g.hteamid && g.ateamid).sort((a, b) => (a.unixtime || 0) - (b.unixtime || 0));
  for (const g of sorted) {
    const eH = getElo(g.hteamid), eA = getElo(g.ateamid);
    const H = hgaFor(g);
    const pHome = expHome(eH, eA, H);
    const homePick = pHome >= 0.5;
    PRED[g.id] = {
      pickId: homePick ? g.hteamid : g.ateamid,
      conf: Math.round(Math.max(pHome, 1 - pHome) * 100),
      margin: Math.max(1, Math.round(Math.abs(eH + H - eA) / MARGIN_DIV)),
      eloDiff: Math.round(Math.abs(eH + H - eA)), homePick,
    };
    if (g.complete === 100) {
      // Squiggle marks a draw with winnerteamid null (not 0) - a completed game with no winner is a draw,
      // excluded from grading (the margin multiplier already makes it a no-op for Elo since margin = 0)
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
}

function formStr(id) {
  const f = (FORM[id] || []).slice(-5);
  const w = f.filter(Boolean).length;
  return { w, n: f.length };
}

function reason(g, p) {
  const win = TEAM[p.pickId];
  const opp = p.pickId === g.hteamid ? TEAM[g.ateamid] : TEAM[g.hteamid];
  const rW = RANK[p.pickId], rO = RANK[p.pickId === g.hteamid ? g.ateamid : g.hteamid];
  const bits = [];
  bits.push(p.eloDiff >= 120 ? `rated well clear of ${opp}` : p.eloDiff >= 50 ? `rated ahead of ${opp}` : `a whisker ahead in a line-ball game`);
  if (rW && rO && rW < rO) bits.push(`${rO - rW} spot${rO - rW > 1 ? 's' : ''} higher on the ladder`);
  const fm = formStr(p.pickId);
  if (fm.n >= 3) bits.push(`${fm.w} of their last ${fm.n} won`);
  if (p.homePick) bits.push(`at home at ${g.venue || 'home'}`);
  return bits.slice(0, 3).join(', ') + '.';
}

const roundsList = () => [...new Set(DATA.games.map(g => g.round))].sort((a, b) => a - b);

function roundRecord(r) {
  let c = 0, t = 0;
  for (const g of DATA.games.filter(g => g.round === r)) {
    const p = PRED[g.id];
    if (p && g.complete === 100 && g.winnerteamid != null && g.winnerteamid !== 0) { t++; if (p.pickId === g.winnerteamid) c++; }
  }
  return { c, t };
}

function changeRound(delta) {
  const rounds = roundsList();
  let idx = rounds.indexOf(VIEW_ROUND);
  idx = Math.min(Math.max(idx + delta, 0), rounds.length - 1);
  VIEW_ROUND = rounds[idx];
  renderTips();
}

function renderTips() {
  const rounds = roundsList();
  if (VIEW_ROUND == null) VIEW_ROUND = DATA.nextRound;
  let idx = rounds.indexOf(VIEW_ROUND);
  if (idx < 0) idx = rounds.length - 1;
  VIEW_ROUND = rounds[idx];
  const r = VIEW_ROUND;
  $('round').textContent = 'Round ' + r;
  $('rprev').disabled = idx <= 0;
  $('rnext').disabled = idx >= rounds.length - 1;
  const rec = roundRecord(r);
  $('roundrec').textContent = rec.t ? `${rec.c}/${rec.t} correct` : (r === DATA.nextRound ? 'upcoming' : '');
  const games = DATA.games.filter(g => g.round === r).sort((a, b) => (a.unixtime || 0) - (b.unixtime || 0));
  if (!games.length) { $('tips').innerHTML = '<div class="empty">No fixtures.</div>'; return; }
  $('tips').innerHTML = games.map(g => {
    const p = PRED[g.id]; const win = TEAM[p.pickId];
    const done = g.complete === 100 && g.winnerteamid != null;
    const conf = p.conf, lean = conf >= 68 ? 'strong' : conf >= 57 ? 'lean' : 'toss-up';
    return `<div class="game ${done ? (p.right ? 'hit' : 'miss') : ''}">
      <div class="matchup">
        <span class="${p.pickId === g.hteamid ? 'pick' : ''}">${g.hteam}</span>
        <span class="vs">v</span>
        <span class="${p.pickId === g.ateamid ? 'pick' : ''}">${g.ateam}</span>
      </div>
      <div class="callrow">
        <span class="call">Tip: <b>${win}</b> by ${p.margin}</span>
        <span class="conf ${lean}">${conf}%</span>
        ${done ? `<span class="result">${g.hscore}-${g.ascore} ${p.right ? '✓' : '✗'}</span>` : ''}
      </div>
      ${done ? '' : `<div class="why">${reason(g, p)}</div>`}
    </div>`;
  }).join('');
}

function renderLadder() {
  const s = [...DATA.standings].sort((a, b) => a.rank - b.rank);
  $('ladder').innerHTML = `<table><thead><tr><th>#</th><th class="l">Team</th><th>P</th><th>W</th><th>L</th><th>%</th><th>Pts</th></tr></thead><tbody>${
    s.map(t => `<tr><td>${t.rank}</td><td class="l">${t.name}</td><td>${t.played}</td><td>${t.wins}</td><td>${t.losses}</td><td>${t.percentage.toFixed(0)}</td><td><b>${t.pts}</b></td></tr>`).join('')
  }</tbody></table>`;
}

function renderBoard() {
  const minTotal = Math.max(5, Math.round(OUR.total * 0.5));
  const rows = DATA.experts
    .filter(e => e.total >= minTotal)
    .map(e => ({ source: e.source, correct: e.correct, total: e.total, pct: e.correct / e.total * 100 }));
  rows.push({ source: '★ AFL Oracle (this model)', correct: OUR.correct, total: OUR.total, pct: OUR.pct, us: true });
  rows.sort((a, b) => b.pct - a.pct);
  const ourRank = rows.findIndex(r => r.us) + 1;
  $('boardnote').textContent = `This model ranks #${ourRank} of ${rows.length} tipsters (${OUR.correct}/${OUR.total}, ${OUR.pct.toFixed(1)}%).`;
  $('board').innerHTML = `<table><thead><tr><th>#</th><th class="l">Tipster</th><th>Correct</th><th>%</th></tr></thead><tbody>${
    rows.map((r, i) => `<tr class="${r.us ? 'us' : ''}"><td>${i + 1}</td><td class="l">${r.source}</td><td>${r.correct}/${r.total}</td><td><b>${r.pct.toFixed(1)}</b></td></tr>`).join('')
  }</tbody></table>`;
}

function setStatus(s) { const el = $('status'); el.className = 'dot ' + ({ ok: 'ok', err: 'err' }[s] || 'loading'); }

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
  t.classList.add('on'); $(t.dataset.p).classList.add('on');
}));

$('rprev').addEventListener('click', () => changeRound(-1));
$('rnext').addEventListener('click', () => changeRound(1));

load();
