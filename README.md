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
- **Monash Probabilistic Footy Tipping Competition** (probabilistic-footy.monash.edu) - free and open
  to bots, but submission is a login-gated web form (Alias + Password), with no public API. Automating
  it needs a weekly job that logs in and POSTs the probabilities from `/api/tips`. That job is **not
  built yet** - it needs a registered account first (contact monash.footy@gmail.com), then credentials
  stored as GitHub Actions secrets.

Courtesy: Squiggle's API rules ask a bot's User-Agent to include a contact email; ours
(`Cludestradamus/1.0 (+https://afl-oracle.pages.dev)`) currently has a URL only.

## Deploy
Static site + one Function -> Cloudflare Pages project `afl-oracle` via GitHub Action on push to
`master` (secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://afl-oracle.pages.dev
