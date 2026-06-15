# AFL Oracle

A transparent stat model that tips every AFL game each round - winner, margin, confidence and a
one-line reason - then grades itself against the established prediction models and the punters.

- **This Round** - the model's locked-in tips with a confidence read and an analyst reason.
- **Ladder** - the live AFL ladder.
- **Tipster Ranking** - the model's season accuracy ranked head-to-head against every Squiggle model
  and the crowd. Is a simple Elo any good?

## How the picks work (and why they're "locked in")
An Elo model with home-ground advantage and margin-aware updates. Because Elo is **deterministic**,
each round's pick is computed using only games played *before* that round - so the season scorecard is
a genuine, hindsight-free record, fully reproducible from public data. No AI, no API key.

Data comes from the keyless [Squiggle API](https://api.squiggle.com.au/) (games, ladder, and every
model's tips), proxied through a Cloudflare Pages Function (`/api/data`) that adds CORS, tallies the
expert leaderboard, and caches for 10 minutes.

## Deploy
Static site + one Function -> Cloudflare Pages project `afl-oracle` via GitHub Action on push to
`master` (secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://afl-oracle.pages.dev
