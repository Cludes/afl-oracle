// Cludestradamus - this file is rendering only. The prediction model lives in model.js, shared with
// the /api/tips endpoint so what the site shows and what we submit to a comp can never drift apart.
import { runModel } from './model.js';

const $ = id => document.getElementById(id);

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
  const m = runModel(DATA);
  Object.assign(TEAM, m.TEAM);
  Object.assign(RANK, m.RANK);
  Object.assign(FORM, m.FORM);
  Object.assign(PRED, m.PRED);
  OUR.correct = m.OUR.correct; OUR.total = m.OUR.total; OUR.pct = m.OUR.pct;
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
  rows.push({ source: '★ Cludestradamus (this model)', correct: OUR.correct, total: OUR.total, pct: OUR.pct, us: true });
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
