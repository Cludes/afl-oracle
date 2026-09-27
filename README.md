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
is a backtest, not a locked-in record, and it changes whenever the model does. (The
[Monash ladder](https://probabilistic-footy.monash.edu/~footy/ladder.shtml) under the alias
Cludestradamus is locked in, but from 2027 it records the Monash entry below, not this Elo.)

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

## The Monash entry is not the Elo

The site, and `hconfidence` in `/api/tips`, are the Elo - that is what Cludestradamus is. What gets
submitted to the Monash comp is `comp.js`: a blend of the betting market (Squiggle's "Punters") and
the 10 Squiggle models that scored best the previous season, 40/60 in log-odds, stretched x1.2
because averaging pulls toward 0.5.

The reason is simply that it wins. Leave-one-season-out over 2022-2026 the blend scored 0.2012
bits/game against the Elo's 0.1773, and in every fold it gave the Elo zero weight - the market and
the best models already know everything the Elo does. Scored against the real 2026 Monash field game
by game, it would have finished **2nd of 76** full-season tippers, 0.001 bits/game behind the winner,
where the Elo finished 18th. Allowing for luck (bootstrapping the games), that is roughly a 1-in-3
chance of winning a season, 72% top three and 97% top ten. It is not a lock: the top five are
separated by less than one season's worth of noise.

Two honest limits. Squiggle's archive holds each tip's *final* pre-game value, and ours is submitted
during the week, so live results will land somewhat below the backtest - by an amount that can be
measured after a few rounds, by comparing our submitted values (on the Monash ladder) with Squiggle's
finals. And Monash itself runs a "BookieOdds" auto-tipper and lists it among its "honest
algorithms", so an odds-based entry is squarely within its rules; everything used is public before
each game.

    node scripts/backtest-comp.mjs                     # blend vs Elo, season by season
    node scripts/backtest-comp.mjs --sources-for 2028  # next season's model list for comp.js

## Before round 1 each season

1. `node scripts/backtest-comp.mjs --sources-for <year>` and add the list to `SOURCES_BY_SEASON` in
   `comp.js`. Without it the previous list is reused (it still works, just a year stale), and every
   run's log says so.
2. Once the fixture is out, **Run workflow** with *dry_run* ticked. Check each box maps to the right
   game, and note whether the log shows `[form currently holds ...]` - that says whether Monash
   pre-fills existing tips, which decides the next point.
3. Scheduled runs deliberately never touch a round once a game has started, because what a
   resubmission does to games already under way is unverified. To find out: after round 1's first
   game, run the workflow with the round number (which bypasses the guard), then check round 1 on the
   Monash ladder once it is scored - if game 1 still shows the value from before its bounce,
   resubmitting mid-round is safe, and weekend refresh runs could be added for later games.

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
`started`, and `comp` - the Monash entry's home-win probability (`comp.hconfidence`), what it was
built from (`basis`: market+models, market, models, or elo when neither has been posted yet), and how
many of the chosen models had tipped. `comp_models` names them.

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
  `game1..gameN` as the home team's win probability (the blend above, not the Elo), clamped to
  0.01-0.99 so a wrong tip can't score an infinite penalty. `.github/workflows/submit-monash-tips.yml`
  runs it Tue, Wed and Thu mornings plus Thu and Fri late afternoon AEST - resubmitting overwrites the
  previous entry, so the mornings retry each other and the afternoons refresh with fresher prices;
  the last run before the first bounce is the one that counts. Once any game has started a scheduled
  run leaves the round alone, and when the feed says `open: false` (the off-season) it exits 0 without
  logging in. To submit a round by hand - say, to recover one no scheduled run managed - run the
  workflow with the round number, which bypasses both. The form may list fewer games than the
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
