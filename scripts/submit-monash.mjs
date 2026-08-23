/**
 * Submit the current round's tips to the Monash Probabilistic Footy Tipping Competition.
 *
 * The comp has no API - it is a two-stage login-gated web form:
 *   1. POST name/passwd/comp/round to presentTips.cgi.pl  -> the tips form for that round
 *   2. POST that form back, with game1..gameN filled in   -> processTips.cgi.pl confirms
 *
 * In the probabilistic comp (comp=info) each gameN is the probability the HOME team wins,
 * as a decimal 0-1. Those come from our own /api/tips feed, so what gets submitted can
 * never drift from what the site shows.
 *
 * Usage: MONASH_USER=.. MONASH_PASS=.. node scripts/submit-monash.mjs [--round N] [--dry-run]
 *
 * --dry-run does everything except the final POST and prints the mapping it worked out.
 * Resubmitting a round overwrites the previous entry, so running twice a week is safe.
 */

const BASE = 'https://probabilistic-footy.monash.edu/~footy/';
const PRESENT = BASE + 'cgi-bin/presentTips.cgi.pl';
const TIPS_URL = process.env.TIPS_URL || 'https://afl-oracle.pages.dev/api/tips';
const UA = process.env.MONASH_UA || 'Cludestradamus/1.0 (+https://afl-oracle.pages.dev)';
const COMP = process.env.MONASH_COMP || 'info';
const CLAMP = 0.01; // never submit 0 or 1 - the info comp scores those as an infinite penalty

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ASSUME_ORDER = args.includes('--assume-order');
const roundArg = args.includes('--round') ? args[args.indexOf('--round') + 1] : null;

const USER = process.env.MONASH_USER;
const PASS = process.env.MONASH_PASS;
if (!USER || !PASS) die('MONASH_USER and MONASH_PASS must be set');

main().catch((e) => die(e.stack || String(e)));

async function main() {
  const feed = await getJson(roundArg ? TIPS_URL + '?round=' + roundArg : TIPS_URL);
  if (!feed.tips || !feed.tips.length) die('no tips in the feed for round ' + feed.round);
  const round = roundArg != null ? Number(roundArg) : feed.round;
  log('feed: round ' + round + ', ' + feed.tips.length + ' games (generated ' + feed.generated + ')');

  const html = await post(PRESENT, { name: USER, passwd: PASS, comp: COMP, round: String(round) });
  if (!/name=["']?game1["']?/i.test(html)) {
    // the CGI answers 200 with a prose error for bad credentials or a closed round
    const why = (text(html).match(/Sorry,[^.]*\./) || ['check the credentials, comp and that the round is still open'])[0];
    die('no tips form returned - ' + why);
  }

  const form = parseForm(html);
  const rows = gameRows(html, form.gameFields.length);
  const values = mapTips(feed.tips, rows, form.gameFields);

  form.gameFields.forEach((f, i) => log('  ' + f + ' = ' + values[f] + '  (' + rows[i].label + ')'));

  if (DRY) { log('dry run - would POST ' + Object.keys(form.fields).length + ' carried fields + ' + form.gameFields.length + ' probabilities to ' + form.action); return; }

  const body = text(await post(form.action, { ...form.fields, ...values }));
  if (/sorry|invalid|error/i.test(body) && !/success|received|thank/i.test(body)) {
    die('submission rejected: ' + body.replace(/\s+/g, ' ').trim().slice(0, 400));
  }
  log('submitted round ' + round + ' to the ' + COMP + ' competition as ' + USER);
}

/* ---------- HTTP ---------- */

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
  return r.json();
}

async function post(url, fields) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  if (!r.ok) throw new Error('POST ' + url + ' -> ' + r.status);
  return r.text();
}

/* ---------- form parsing ----------
 * The page is hand-written 1990s HTML, so we re-send every field the form hands us
 * (including the hidden ones that carry the login into stage 2) and override only the
 * gameN probabilities. That way we never have to model fields we do not understand.
 */

function parseForm(html) {
  const m = html.match(/<form[^>]*action\s*=\s*["']?([^"'\s>]+)/i);
  if (!m) throw new Error('no <form action> on the tips page');
  const action = new URL(m[1], PRESENT).toString();

  const fields = {};
  const gameFields = [];
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    if (/^game\d+$/i.test(name)) { if (!gameFields.includes(name)) gameFields.push(name); continue; }
    fields[name] = attr(tag, 'value') || '';
  }
  for (const sel of html.match(/<select\b[\s\S]*?<\/select>/gi) || []) {
    const name = attr(sel, 'name');
    if (!name) continue;
    const chosen = (sel.match(/<option\b[^>]*\bselected\b[^>]*>/i) || sel.match(/<option\b[^>]*>/i) || [])[0];
    fields[name] = chosen ? (attr(chosen, 'value') || '') : '';
  }
  gameFields.sort((a, b) => num(a) - num(b));
  return { action, fields, gameFields };
}

/**
 * Slice the page into one text blob per gameN input, so each probability box can be
 * matched to the team names printed beside it. Order alone is not trusted: nothing
 * guarantees the form lists the fixture in the same order our feed does.
 */
function gameRows(html, count) {
  const marks = [];
  const re = /<input\b[^>]*name\s*=\s*["']?(game\d+)["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) marks.push({ name: m[1], at: m.index });
  marks.sort((a, b) => num(a.name) - num(b.name));

  return marks.map((mark, i) => {
    const from = i === 0 ? 0 : marks[i - 1].at;
    const label = text(html.slice(from, mark.at)).replace(/\s+/g, ' ').trim().slice(-120);
    return { name: mark.name, label, teams: findTeams(label) };
  }).slice(0, count);
}

function mapTips(tips, rows, gameFields) {
  if (rows.length !== tips.length) {
    die('the form has ' + rows.length + ' games but the feed has ' + tips.length + ' - refusing to guess');
  }
  const out = {};
  const used = new Set();

  rows.forEach((row, i) => {
    let tip = null;
    let flip = false;
    if (row.teams.length === 2) {
      const [first, second] = row.teams;
      tip = tips.find((t, j) => !used.has(j) && key(t.hteam) === first && key(t.ateam) === second);
      if (!tip) {
        tip = tips.find((t, j) => !used.has(j) && key(t.hteam) === second && key(t.ateam) === first);
        flip = !!tip; // this row lists the away team first, so invert our home probability
      }
    }
    if (!tip) {
      if (!ASSUME_ORDER) {
        die('could not match "' + row.label + '" to a game in the feed. Re-run with ' +
            '--assume-order to pair them in fixture order instead (check the dry run first).');
      }
      tip = tips[i];
    }
    used.add(tips.indexOf(tip));
    out[gameFields[i]] = clamp((flip ? 100 - tip.hconfidence : tip.hconfidence) / 100).toFixed(2);
  });
  return out;
}

/* ---------- team names ---------- */

const ALIASES = {
  adelaide: 'adelaide', adelaidecrows: 'adelaide', crows: 'adelaide',
  brisbane: 'brisbane', brisbanelions: 'brisbane', lions: 'brisbane',
  carlton: 'carlton', blues: 'carlton',
  collingwood: 'collingwood', magpies: 'collingwood', pies: 'collingwood',
  essendon: 'essendon', bombers: 'essendon',
  fremantle: 'fremantle', dockers: 'fremantle', freo: 'fremantle',
  geelong: 'geelong', geelongcats: 'geelong', cats: 'geelong',
  goldcoast: 'goldcoast', goldcoastsuns: 'goldcoast', suns: 'goldcoast',
  gws: 'gws', gwsgiants: 'gws', giants: 'gws', greaterwesternsydney: 'gws',
  hawthorn: 'hawthorn', hawks: 'hawthorn',
  melbourne: 'melbourne', demons: 'melbourne', dees: 'melbourne',
  northmelbourne: 'northmelbourne', kangaroos: 'northmelbourne',
  portadelaide: 'portadelaide', power: 'portadelaide',
  richmond: 'richmond', tigers: 'richmond',
  stkilda: 'stkilda', saints: 'stkilda',
  sydney: 'sydney', sydneyswans: 'sydney', swans: 'sydney',
  westcoast: 'westcoast', westcoasteagles: 'westcoast', eagles: 'westcoast',
  westernbulldogs: 'westernbulldogs', bulldogs: 'westernbulldogs', footscray: 'westernbulldogs',
};

function key(name) { return ALIASES[String(name).toLowerCase().replace(/[^a-z]/g, '')] || null; }

/** Longest alias first, so "north melbourne" is never read as "melbourne". */
function findTeams(label) {
  const flat = label.toLowerCase().replace(/[^a-z]/g, '');
  const hits = [];
  for (const alias of Object.keys(ALIASES).sort((a, b) => b.length - a.length)) {
    let at = flat.indexOf(alias);
    while (at !== -1) {
      if (!hits.some((h) => at < h.end && at + alias.length > h.at)) {
        hits.push({ at, end: at + alias.length, team: ALIASES[alias] });
      }
      at = flat.indexOf(alias, at + 1);
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.team);
}

/* ---------- small helpers ---------- */

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}
function text(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function num(s) { return Number(String(s).replace(/\D/g, '')); }
function clamp(p) { return Math.min(1 - CLAMP, Math.max(CLAMP, p)); }
function log(m) { console.log(m); }
function die(m) { console.error('submit-monash: ' + m); process.exit(1); }
