/**
 * Tests for the part of the Monash submitter that can silently tip the wrong team:
 * reading club names off the form and pairing each probability box with a game.
 *
 * The form's table is `Game | Ground | Home | Away | [input]`, so the ground name is printed
 * immediately before the clubs - and grounds carry club names ("Adelaide Oval", "GIANTS
 * Stadium"). That is what broke round 26, and why the ground cases below are here.
 *
 * Run: node scripts/test-monash-matching.mjs
 */

import { gameRows, mapTips } from './submit-monash.mjs';

let failed = 0;

/** One row as the CGI prints it: game number, ground, home, away, then the probability box. */
const row = (n, ground, home, away) =>
  `<TR><TD>&nbsp;${n}&nbsp;<TD>${ground}<TD>${home}<TD>${away}` +
  `<TD><INPUT NAME="game${n}" TYPE="text" SIZE="5" VALUE="">`;

function check(name, formRows, tips, expected) {
  const html = '<HTML><FORM ACTION="processTips.cgi.pl" METHOD="POST">' +
    '<INPUT TYPE="hidden" NAME="name" VALUE="x"><TABLE>' + formRows.join('') + '</TABLE></FORM>';
  const fields = tips.map((_, i) => 'game' + (i + 1));
  const got = mapTips(tips, gameRows(html, fields.length), fields);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '\n  expected ' + JSON.stringify(expected) + '\n  got      ' + JSON.stringify(got)));
}

// Round 26 2026, the round that failed: game 4 is at Adelaide Oval, so the row names Adelaide twice.
check('ground repeating a club name', [
  row(1, 'Optus Stadium', 'Fremantle', 'Hawthorn'),
  row(2, 'MCG', 'Geelong', 'Carlton'),
  row(3, 'SCG', 'Sydney', 'Brisbane'),
  row(4, 'Adelaide Oval', 'Adelaide', 'W_Bulldogs'),
], [
  { hteam: 'Fremantle', ateam: 'Hawthorn', hconfidence: 67 },
  { hteam: 'Geelong', ateam: 'Carlton', hconfidence: 61 },
  { hteam: 'Sydney', ateam: 'Brisbane Lions', hconfidence: 53 },
  { hteam: 'Adelaide', ateam: 'Western Bulldogs', hconfidence: 64 },
], { game1: '0.67', game2: '0.61', game3: '0.53', game4: '0.64' });

// Monash's abbreviations. Substring matching read P_Adelaide as Adelaide and G_W_Sydney as
// Sydney - both the wrong club - and found nothing at all in W_Coast.
check('underscore abbreviations', [
  row(1, 'GIANTS Stadium', 'G_W_Sydney', 'P_Adelaide'),
  row(2, 'Optus Stadium', 'W_Coast', 'Kangaroos'),
  row(3, 'Marvel Stadium', 'St_Kilda', 'Gold_Coast'),
], [
  { hteam: 'Greater Western Sydney', ateam: 'Port Adelaide', hconfidence: 55 },
  { hteam: 'West Coast', ateam: 'North Melbourne', hconfidence: 40 },
  { hteam: 'St Kilda', ateam: 'Gold Coast', hconfidence: 72 },
], { game1: '0.55', game2: '0.40', game3: '0.72' });

// A Showdown: the ground carries the AWAY club's name and is printed first, so counting it
// would read the game as reversed and submit the probability upside down.
check('Showdown at Adelaide Oval', [row(1, 'Adelaide Oval', 'P_Adelaide', 'Adelaide')],
  [{ hteam: 'Port Adelaide', ateam: 'Adelaide', hconfidence: 58 }], { game1: '0.58' });

// The form and our feed disagree on which side is home: the probability must invert.
check('game listed away team first', [row(1, 'MCG', 'Carlton', 'Geelong')],
  [{ hteam: 'Geelong', ateam: 'Carlton', hconfidence: 61 }], { game1: '0.39' });

// A certainty scores an infinite penalty in the probabilistic comp, so it is clamped.
check('clamped at 0.99', [row(1, 'MCG', 'Richmond', 'Melbourne')],
  [{ hteam: 'Richmond', ateam: 'Melbourne', hconfidence: 100 }], { game1: '0.99' });

// The form is not required to list the fixture in the same order our feed does.
check('form in a different order', [
  row(1, 'MCG', 'Melbourne', 'Collingwood'),
  row(2, 'Marvel Stadium', 'Essendon', 'Richmond'),
], [
  { hteam: 'Essendon', ateam: 'Richmond', hconfidence: 45 },
  { hteam: 'Melbourne', ateam: 'Collingwood', hconfidence: 70 },
], { game1: '0.70', game2: '0.45' });

console.log(failed ? failed + ' test(s) failed' : 'all tests passed');
process.exit(failed ? 1 : 0);
