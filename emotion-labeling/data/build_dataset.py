"""
Build / extend the task dataset from the Emotion dataset (dair-ai/emotion).

Append-only by design: tweets already in data/tweets.json keep their ids and
text, because collected labels reference those ids. Re-running only tops each
category up to PER_CATEGORY with tweets that are not already present.

    python3 data/build_dataset.py            # top up to the default target
    python3 data/build_dataset.py 40         # target 40 per category

Rewrites data/tweets.json and seed.sql. Apply with `npm run db:seed`.
"""
import collections, json, os, sys, urllib.request

PER_CATEGORY = int(sys.argv[1]) if len(sys.argv) > 1 else 30
NAMES = ["sadness", "joy", "love", "anger", "fear", "surprise"]
MIN_LEN, MAX_LEN = 40, 180
PAGE = 100
MAX_ROWS = 12000
URL = "https://datasets-server.huggingface.co/rows?dataset=dair-ai%2Femotion&config=split&split=train&offset={}&length={}"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TWEETS = os.path.join(HERE, "tweets.json")
SEED = os.path.join(ROOT, "seed.sql")

existing = json.load(open(TWEETS)) if os.path.exists(TWEETS) else []
seen = {t["text"].strip().lower() for t in existing}
have = collections.Counter(t["gold"] for t in existing)
next_id = max((t["id"] for t in existing), default=0) + 1

need = {n: max(0, PER_CATEGORY - have[n]) for n in NAMES}
print("have:", dict(have) or "nothing yet")
print("need:", {n: c for n, c in need.items() if c} or "nothing - already at target")

added = []
offset = 0
while any(need[n] > 0 for n in NAMES) and offset < MAX_ROWS:
    with urllib.request.urlopen(URL.format(offset, PAGE), timeout=30) as r:
        rows = json.load(r)["rows"]
    if not rows:
        break
    for item in rows:
        text = item["row"]["text"].strip()
        label = NAMES[item["row"]["label"]]
        if need[label] <= 0:                      continue
        if not MIN_LEN <= len(text) <= MAX_LEN:   continue
        if text.lower() in seen:                  continue
        seen.add(text.lower())
        added.append({"id": next_id, "text": text, "gold": label})
        next_id += 1
        need[label] -= 1
    offset += PAGE

short = {n: c for n, c in need.items() if c > 0}
if short:
    print("warning: dataset exhausted before reaching target for", short)

tweets = existing + added
json.dump(tweets, open(TWEETS, "w"), indent=2, ensure_ascii=False)

q = lambda s: "'" + s.replace("'", "''") + "'"
with open(SEED, "w") as f:
    f.write("-- Generated from data/tweets.json by data/build_dataset.py\n")
    f.write("-- Idempotent: safe to re-run after labels have been collected.\n")
    f.write("INSERT INTO tweets (id, text, gold_label) VALUES\n")
    f.write(",\n".join("  (%d, %s, %s)" % (t["id"], q(t["text"]), q(t["gold"])) for t in tweets))
    f.write("\nON CONFLICT (id) DO UPDATE SET\n"
            "  text = excluded.text,\n  gold_label = excluded.gold_label;\n")

final = collections.Counter(t["gold"] for t in tweets)
print("added %d, total %d" % (len(added), len(tweets)))
print("per category:", {n: final[n] for n in NAMES})
