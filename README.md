# Cludestradamus

A transparent stat model that tips every AFL game each round - winner, margin, confidence and a
one-line reason - then grades itself against the established prediction models and the punters.
(Formerly "AFL Oracle"; the site still lives at the `afl-oracle` project/URL.)

- **This Round** - the model's tips with a confidence read and an analyst reason.
- **Ladder** - the live AFL ladder.
- **Tipster Ranking** - the model's season ranked head-to-head against every Squiggle model and the
  crowd, on both measures that matter: how often it picks the winner (tips) and how well it priced
  the game (bits per game, what the probabilistic comps score). Is a simple Elo any good?

## How the picks work
An Elo model with travel-aware home-ground advantage and margin-aware updates. Because Elo is
**deterministic**, each round's pick is computed using only games played *before* that round, fully
reproducible from public data. No AI, no API key.

One honest caveat about the season record the site shows: it is recomputed with the **current**
model, and the model's settings were chosen by testing against past seasons, this one included. So it
is a backtest, not a locked-in record, and it changes whenever the model does. The genuinely locked-in
record is what was actually submitted: the [Monash ladder](https://probabilistic-footy.monash.edu/~footy/ladder.shtml)
under the alias Cludestradamus.

The **pick** and the **confidence** come off two different curves over the same rating gap. The pick
uses Elo's own 400 scale, which also drives the rating update. The published probability uses
`SHOW_DIV`, because measured against 2022-2026 results the 400 curve is badly under-confident - games
it called at 0.67 were won 83% of the time. Since a pick is just the sign of the rating gap,
sharpening cannot change who is tipped, only how loudly it is said.

A season also **starts from where the last one finished**: `/api/data` replays last season and passes
each club's final rating, which the model carries in regressed 40% toward the mean. Last year's
ladder is a lossy summary by comparison - it knows where a club finished, not how good it had become.
Of everything tested against five seasons (rest days, adaptive K, finals weighting, home-ground
familiarity, scaling the travel edge), this was worth more than all the rest combined. Clubs also get
a small extra edge at the ground they actually call home, since Geelong at Kardinia Park is not
Geelong at the MCG.

How much a result moves the ratings is sized by **scoring shots**, not just the scoreboard. Goal-kicking
accuracy on the day is mostly noise, so the number of shots each side generated is the steadier read
on who dominated; the update margin is 75% shot margin (shots x 3.65, the league's points per shot)
and 25% real margin. Who won still comes from the real score. This beat the plain scoreboard margin
in every season 2022-2026. The predicted margin is the rating gap divided by `MARGIN_DIV` (6), tuned
on mean absolute error.

Every version, scored on the same 1,063 games (2022-2026) the way production runs:

| Version | bits/game | accuracy | margin MAE |
|---|---|---|---|
| Original | 0.1303 | 69.8% | 27.11 |
| + sharper reported probability | 0.1567 | 69.8% | 27.11 |
| + carry-over + home ground | 0.1711 | 69.5% | 26.82 |
| + scoring shots + margin divisor | 0.1773 | 69.5% | 26.43 |

On 2026 alone that is 0.1572 -> 0.2283 bits/game, roughly mid-table among Squiggle's 31 models.

Things tested and rejected, so nobody re-runs them: rest days, adaptive or finals-weighted K,
scaling the travel edge, and removing the home edge at neutral venues (a Grand Final at the MCG
still scores better WITH the nominal home side's edge, over 95 such games).

## Backtest

    node scripts/backtest.mjs [--from 2022] [--to 2026] [--model path/to/model.js]

Replays each season exactly as production does - last season replayed into starting ratings, then
this season walked forward - and prints bits/game, accuracy and margin MAE per season plus a
calibration table. Judge every model change on this. Squiggle responses are cached in `.cache/`.

Data comes from the keyless [Squiggle API](https://api.squiggle.com.au/) (games, ladder, and every
model's tips), proxied through a Cloudflare Pages Function (`/api/data`) that adds CORS, tallies the
expert leaderboard, and caches for 10 minutes.

## Tips API (`/api/tips`)
A machine-readable feed of the current round's tips, computed on demand from the same `model.js` the
site uses (so published tips never drift from what's shown). Each tip carries the tipped team, the
home-win probability (`hconfidence`, 0-100), and the predicted margin from the home team's
perspective (`hmargin`). Add `?round=N` for a past round.

`open` is false once every game in the round has started, which is also the whole off-season (the
feed keeps pointing at the finished Grand Final until the new fixture starts). Each tip also carries
`started`.

    https://afl-oracle.pages.dev/api/tips

## Entering tipping competitions
The models on the Tipster Ranking are the Squiggle bot community. To compete for real:

- **Squiggle** (the leaderboard here) - curated, pull-based, so **no submission code needed**: message
  Max Barry ([@SquiggleAFL](https://twitter.com/SquiggleAFL) / the Squiggle Discord) to be added and
  point his crawler at `/api/tips` (it already returns win probability + margin in Squiggle's format).
- **Monash Probabilistic Footy Tipping Competition** (probabilistic-footy.monash.edu) - free, open
  to bots, but submission is a login-gated web form with no API. `scripts/submit-monash.mjs` drives
  it: it reads `/api/tips`, logs in (`cgi-bin/presentTips.cgi.pl`), matches each of the form's
  probability boxes to a game **by team name** (flipping the probability if the form lists the away
  team first, and refusing to submit rather than guessing if a row will not match), and posts
  `game1..gameN` as the home team's win probability, clamped to 0.01-0.99 so a wrong tip can't score
  an infinite penalty. `.github/workflows/submit-monash-tips.yml` runs it Tue, Wed and Thu mornings
  AEST - resubmitting a round overwrites the previous entry, so the later runs are retries that also
  pick up any movement. When the feed says `open: false` it exits 0 without logging in, so the
  off-season is quiet rather than a failed run every week. The form may list fewer games than the
  feed if Monash drops ones already under way; each box is still matched by name, so that is fine.
  Credentials come from the repo secrets `MONASH_TIPPING_SECRET_USER` / `MONASH_TIPPING_SECRET_PW`.

  Check it without submitting - locally, or via **Run workflow** with *dry_run* ticked:

      MONASH_USER=.. MONASH_PASS=.. node scripts/submit-monash.mjs --dry-run

  The form's table is `Game | Ground | Home | Away`, and grounds carry club names ("Adelaide
  Oval", "GIANTS Stadium"), while the clubs themselves are abbreviated (`P_Adelaide`, `W_Coast`,
  `G_W_Sydney`). Reading those wrong tips the wrong team silently, so
  `scripts/test-monash-matching.mjs` covers each case and runs before every submission.

  The other two Monash comps need a tipped side and a margin rather than a probability; pass
  `MONASH_COMP=normal` or `gauss` only after teaching the script those extra fields.

Courtesy: Squiggle's API rules ask a bot's User-Agent to include a contact email; ours
(`Cludestradamus/1.0 (+https://afl-oracle.pages.dev)`) currently has a URL only.

## Deploy
Static site + one Function -> Cloudflare Pages project `afl-oracle` via GitHub Action on push to
`master` (secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://afl-oracle.pages.dev
