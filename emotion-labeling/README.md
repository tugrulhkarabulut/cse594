# CSE 594 Assignment 1: Emotion Labeling Task

A web interface where a participant labels 5 randomly selected tweets with one of
six emotions (anger, fear, joy, love, sadness, surprise), and a backend that records
who labeled which tweet with which label.

## For the grader: nothing to install or run

The task is deployed and running. Open it in a browser:

| | |
|---|---|
| **Task** | <https://emotion-labeling.cse594-a1-emotion-labeling.workers.dev> |
| **Collected data** | <https://emotion-labeling.cse594-a1-emotion-labeling.workers.dev/admin> |
| **Dashboard login** | leave the username empty, the password is in the submitted PDF |

The dashboard shows every label collected so far and exports them as CSV. The rest
of this file documents how the task is built, how to run it locally, and how to
deploy it, none of which is needed to try the task or read the data.

## Architecture

| Layer | What it is |
|---|---|
| Frontend | `public/index.html`: instructions, labeling screen, thank-you screen |
| Backend | `src/index.js`: a Cloudflare Worker exposing a small JSON API |
| Database | Cloudflare D1 (SQLite): `tweets`, `participants`, `labels` |

Requests for `/api/*` are handled by the Worker; everything else is served as a
static asset.

### API

| Route | Does |
|---|---|
| `POST /api/session` | Creates a participant row, samples 5 tweets **server-side** (`ORDER BY RANDOM()`), stores the assignment, returns the tweets without their gold labels |
| `POST /api/label` | Records one decision: chosen label, gold label, agreement, position, dwell time |
| `POST /api/complete` | Marks the session finished |

Two design points worth noting:

- **Sampling is server-side**, so each participant provably gets a different draw and the
  assignment is recorded rather than trusted from the browser.
- **`/api/label` rejects tweets that were not assigned** to that participant, and rejects
  labels outside the six categories, so the collected data can't be polluted by a
  hand-crafted request.

## The dataset

`data/tweets.json` holds 180 tweets from the [Emotion dataset](https://huggingface.co/datasets/dair-ai/emotion)
(`dair-ai/emotion`), **30 per category**. Extend it with:

```bash
python3 data/build_dataset.py 40   # top every category up to 40
npm run db:seed                    # push the new rows
```

It pages through the HuggingFace datasets API, keeps texts 40-180 characters long,
de-duplicates, and balances across the six labels. Balancing matters: `love` and
`surprise` are each only ~3-4% of the raw dataset, so an unstratified sample would
under-represent them.

The script is **append-only**: tweets already in `tweets.json` keep their ids and text,
because collected labels reference those ids. Re-running only adds what is missing and
regenerates `seed.sql`.

`seed.sql` is a build artifact and is not tracked in git. Generate it after
cloning, before the first seed:

```bash
python3 data/build_dataset.py     # writes seed.sql from data/tweets.json
```

## Running it locally

Only needed to develop or inspect it offline, the deployed task above is the one
participants used.

```bash
npm install
python3 data/build_dataset.py   # generate seed.sql from data/tweets.json
npm run db:migrate:local        # create the tables
npm run db:seed:local           # load the 180 tweets
npm run dev                # http://127.0.0.1:8787
```

## Deploying

Already deployed; these are the steps to reproduce it from scratch:

```bash
npx wrangler login                      # one-time, opens a browser
npx wrangler d1 create emotion_labels   # copy the printed database_id into wrangler.jsonc
python3 data/build_dataset.py           # generate seed.sql
npm run db:migrate                      # create tables on the remote DB
npm run db:seed                         # load the 180 tweets
npm run deploy                          # prints the public https://…workers.dev URL
```

To push a change to the live site afterwards, `npm run deploy` alone is enough.
The database is untouched.

### Changing the schema later

Add a new file under `migrations/` (e.g. `0002_add_confidence.sql`) containing only
the change, then `npm run db:migrate`. Wrangler tracks which migrations have run, so
applying twice is a no-op and existing data is never dropped. `seed.sql` upserts by
tweet id, so re-seeding after a dataset edit also preserves collected labels.

## The admin dashboard

`/admin` shows the collected data: summary tiles, a per-participant table, a
gold-vs-chosen confusion matrix, every individual label, and a CSV download.

It is protected by HTTP Basic auth (any username; the password is what matters).
The password lives in a Cloudflare secret, never in this repo:

```bash
npx wrangler secret put ADMIN_PASSWORD    # set or rotate it
```

Two things keep it from leaking:

- The page is imported from `src/admin.html` and served by the Worker *after* the
  auth check. It is deliberately **not** in `public/`, because static assets are
  served before the Worker runs and would be readable without a password.
- `/api/session` returns only `id` and `text` for each tweet. Gold labels never
  reach the participant's browser, so nobody can read the answer key mid-task.

## Looking at the collected data

```bash
npm run export            # writes labels.csv (add -- --local for the dev database)
```

Or from the dashboard's CSV link, or query directly:

```bash
npx wrangler d1 execute emotion_labels --remote --command \
  "SELECT participant_id, tweet_id, chosen_label, gold_label, created_at FROM labels ORDER BY created_at"
```

## Files

```
data/build_dataset.py   builds/extends the balanced tweet set from HuggingFace
data/tweets.json        the task dataset (text + gold label)
migrations/             versioned schema changes (0001 = initial tables)
seed.sql                generated upserts (not tracked; see above)
src/index.js            Worker: the JSON API
public/index.html       the participant-facing interface
scripts/export.mjs      dumps collected labels to CSV
wrangler.jsonc          Cloudflare config (Worker name, assets, D1 binding)
```
