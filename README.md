# Cludestradamus

A transparent stat model that tips every AFL game each round - winner, margin, confidence and a
one-line reason - then grades itself against the established prediction models and the punters.
(Formerly "AFL Oracle"; the site still lives at the `afl-oracle` project/URL.)

- **This Round** - the model's locked-in tips with a confidence read and an analyst reason.
- **Ladder** - the live AFL ladder.
- **Tipster Ranking** - the model's season accuracy ranked head-to-head against every Squiggle model
  and the crowd. Is a simple Elo any good?

## How the picks work (and why they're "locked in")
An Elo model with travel-aware home-ground advantage and margin-aware updates. Because Elo is **deterministic**,
each round's pick is computed using only games played *before* that round - so the season scorecard is
a genuine, hindsight-free record, fully reproducible from public data. No AI, no API key.

The **pick** and the **confidence** come off two different curves over the same rating gap. The pick
uses Elo's own 400 scale, which also drives the rating update. The published probability uses a 225
divisor, because measured against 2022-2026 results the 400 curve is badly under-confident - games it
called at 0.67 were won 83% of the time. Since a pick is just the sign of the rating gap, sharpening
the probability cannot change who is tipped: accuracy is 70.0% either way, while the comp-scoring
rate improves about 20% (leave-one-season-out: +0.0257 bits/game).

Data comes from the keyless [Squiggle API](https://api.squiggle.com.au/) (games, ladder, and every
model's tips), proxied through a Cloudflare Pages Function (`/api/data`) that adds CORS, tallies the
expert leaderboard, and caches for 10 minutes.

## Tips API (`/api/tips`)
A machine-readable feed of the current round's tips, computed on demand from the same `model.js` the
site uses (so published tips never drift from what's shown). Each tip carries the tipped team, the
home-win probability (`hconfidence`, 0-100), and the predicted margin from the home team's
perspective (`hmargin`). Add `?round=N` for a past round.

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
  an infinite penalty. `.github/workflows/submit-monash-tips.yml` runs it Wed + Thu mornings AEST -
  resubmitting a round overwrites the previous entry, so the second run just picks up any movement.
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
