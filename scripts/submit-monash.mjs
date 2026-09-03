import { pathToFileURL } from 'node:url';

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

// importable for the matching tests; only submits when run as a script
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || String(e)));
}

async function main() {
  if (!USER || !PASS) die('MONASH_USER and MONASH_PASS must be set');
  const feed = await getJson(roundArg ? TIPS_URL + '?round=' + roundArg : TIPS_URL);
  if (!feed.tips || !feed.tips.length) die('no tips in the feed for round ' + feed.round);
  const round = roundArg != null ? Number(roundArg) : feed.round;
  log('feed: round ' + round + ', ' + feed.tips.length + ' games (generated ' + feed.generated + ')');

  const html = await post(PRESENT, { name: USER, passwd: PASS, comp: COMP, round: String(round) });
  if (!/name=["']?game1["']?/i.test(html)) {
    // the CGI answers 200 with a prose error for bad credentials or a closed round
    const said = text(html).replace(/\s+/g, ' ').trim();
    const why = (said.match(/Sorry,[^.]*\./) || [''])[0];
    die('no tips form returned for round ' + round + ' - ' +
        (why || 'check the credentials, comp, and that the round is open') +
        '\n  page said: ' + said.slice(0, 400));
  }

  const form = parseForm(html);
  const rows = gameRows(html, form.gameFields.length);
  const values = mapTips(feed.tips, rows, form.gameFields);

  form.gameFields.forEach((f, i) => log('  ' + f + ' = ' + values[f] + '  (' + rows[i].label + ')'));

  if (DRY) { log('dry run - would POST ' + Object.keys(form.fields).length + ' carried fields + ' + form.gameFields.length + ' probabilities to ' + form.action); return; }

  const raw = await post(form.action, { ...form.fields, ...values });
  const body = text(raw).replace(/\s+/g, ' ').trim();
  if (/Sorry,/i.test(body) || !/<table/i.test(raw)) {
    die('submission rejected - page said: ' + body.slice(0, 400));
  }
  log('submitted round ' + round + ' to the ' + COMP + ' competition as ' + USER);
}

/* ---------- HTTP ---------- */

async function getJson(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (attempt < 3) await new Promise((ok) => setTimeout(ok, attempt * 5000));
    }
  }
  throw last;
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
    const label = text(html.slice(from, mark.at)).replace(/\s+/g, ' ').trim().slice(-200);
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
    // Find the feed game whose two clubs BOTH appear in this row, rather than assuming the row
    // names exactly two - ground names carry club names too ("Adelaide Oval", "Gold Coast
    // Stadium"), so a row can legitimately mention three.
    let tip = null;
    let flip = false;
    for (let j = 0; j < tips.length; j++) {
      if (used.has(j)) continue;
      const home = key(tips[j].hteam);
      const away = key(tips[j].ateam);
      if (!home || !away) continue;
      const atHome = row.teams.indexOf(home);
      const atAway = row.teams.indexOf(away);
      if (atHome === -1 || atAway === -1) continue;
      tip = tips[j];
      flip = atAway < atHome; // this row lists the away team first, so invert our home probability
      used.add(j);
      break;
    }
    if (!tip) {
      if (!ASSUME_ORDER) {
        die('could not match "' + row.label + '" (read as: ' + (row.teams.join(', ') || 'no clubs found') +
            ') to a game in the feed [' + tips.map((t) => t.hteam + ' v ' + t.ateam).join('; ') + ']. ' +
            'Re-run with --assume-order to pair them in fixture order instead (check the dry run first).');
      }
      tip = tips[i];
      used.add(i);
    }
    out[gameFields[i]] = clamp((flip ? 100 - tip.hconfidence : tip.hconfidence) / 100).toFixed(2);
  });
  return out;
}

/* ---------- team names ---------- */

/**
 * Both spellings of every club: ours (Squiggle's, e.g. "Greater Western Sydney") and Monash's
 * underscore abbreviations as they appear on the form ("G_W_Sydney", "P_ADELAIDE", "W_COAST").
 * Matching is on WHOLE tokens, never substrings - "P_ADELAIDE" contains "adelaide" and
 * "G_W_Sydney" contains "sydney", so a substring match silently tips the wrong club.
 */
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
  gwsydney: 'gws', gwssydney: 'gws',
  hawthorn: 'hawthorn', hawks: 'hawthorn',
  melbourne: 'melbourne', demons: 'melbourne', dees: 'melbourne',
  northmelbourne: 'northmelbourne', kangaroos: 'northmelbourne', nmelbourne: 'northmelbourne',
  portadelaide: 'portadelaide', power: 'portadelaide', padelaide: 'portadelaide',
  richmond: 'richmond', tigers: 'richmond',
  stkilda: 'stkilda', saints: 'stkilda',
  sydney: 'sydney', sydneyswans: 'sydney', swans: 'sydney',
  westcoast: 'westcoast', westcoasteagles: 'westcoast', eagles: 'westcoast', wcoast: 'westcoast',
  westernbulldogs: 'westernbulldogs', bulldogs: 'westernbulldogs', footscray: 'westernbulldogs',
  wbulldogs: 'westernbulldogs',
};

function key(name) { return ALIASES[String(name).toLowerCase().replace(/[^a-z]/g, '')] || null; }

/**
 * Read the club names out of a row of form text. Tokens are matched longest-run-first so
 * "West Coast" and "North Melbourne" beat the single words inside them, and a token that is
 * not a club (dates, grounds, "vs") is skipped rather than guessed at.
 */
const VENUE_WORDS = new Set(['oval', 'stadium', 'park', 'arena', 'ground', 'showground', 'showgrounds']);

function findTeams(label) {
  const tokens = label.split(/[^A-Za-z_]+/).filter(Boolean).map((t) => t.toLowerCase().replace(/_/g, ''));
  const found = [];
  for (let i = 0; i < tokens.length; ) {
    let hit = null;
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      const team = ALIASES[tokens.slice(i, i + n).join('')];
      if (team) { hit = { team, n }; break; }
    }
    if (!hit) { i++; continue; }
    // "Adelaide Oval" and "Gold Coast Stadium" are grounds, not the clubs playing - counting them
    // would flip a Showdown, where the ground carries the away team's name and is printed first
    if (!VENUE_WORDS.has(tokens[i + hit.n])) found.push(hit.team);
    i += hit.n;
  }
  return found;
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

export { findTeams, key, gameRows, mapTips, parseForm };
