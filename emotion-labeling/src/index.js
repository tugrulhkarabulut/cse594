/**
 * CSE 594 Assignment 1: emotion labeling task backend.
 *
 * Routes:
 *   GET  /admin         -> password-protected dashboard (see handleAdmin)
 *
 * Participant routes (all JSON):
 *   POST /api/session   -> create a participant, sample 5 random tweets, return them
 *   POST /api/label     -> record one (participant, tweet, label) decision
 *   POST /api/complete  -> mark the session finished, return a short summary
 *
 * Anything that is not /api/* is served from ./public by the assets binding.
 */

import ADMIN_PAGE from "./admin.html";

const LABELS = ["anger", "fear", "joy", "love", "sadness", "surprise"];
const TWEETS_PER_PARTICIPANT = 5;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const bad = (message, status = 400) => json({ error: message }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Admin is handled before assets so it can never be served unauthenticated.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(url, request, env);
    }
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return bad("Method not allowed", 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return bad("Expected a JSON body");
    }

    try {
      switch (url.pathname) {
        case "/api/session":  return await startSession(body, request, env);
        case "/api/label":    return await recordLabel(body, env);
        case "/api/complete": return await completeSession(body, env);
        default:              return bad("Not found", 404);
      }
    } catch (err) {
      console.error(err);
      return bad("Server error", 500);
    }
  },
};

/**
 * Start (or resume) a session.
 *
 * One person gets one id: the browser keeps the id it was given and sends it back
 * as `returningId`, so reloading the page or closing the tab and coming back
 * resumes the same participant row with the same five tweets, rather than
 * creating a second identity for the same person.
 */
async function startSession(body, request, env) {
  const displayName = String(body.displayName ?? "").trim().slice(0, 80) || null;
  const returningId = String(body.returningId ?? "").trim() || null;

  if (returningId) {
    const existing = await env.DB.prepare(
      "SELECT id, assigned_ids, completed_at FROM participants WHERE id = ?"
    ).bind(returningId).first();
    if (existing) return json(await resumeSession(existing, displayName, env));
  }

  const sampled = await sampleUnseenSet(env);
  if (!sampled) return bad("Task dataset is not seeded", 500);

  const participantId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO participants (id, display_name, user_agent, assigned_ids, started_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    participantId,
    displayName,
    request.headers.get("user-agent")?.slice(0, 300) ?? null,
    JSON.stringify(sampled.map((t) => t.id)),
    new Date().toISOString()
  ).run();

  return json({
    participantId,
    tweets: sampled,
    labels: LABELS,
    answered: 0,
    completed: false,
  });
}

/**
 * Draw 5 tweets, rejecting a draw that some earlier participant already got as
 * their exact set, so no two participants are handed the same five messages.
 */
async function sampleUnseenSet(env) {
  const { results: taken } = await env.DB.prepare(
    "SELECT assigned_ids FROM participants"
  ).all();
  const seen = new Set(
    (taken ?? []).map((row) => JSON.parse(row.assigned_ids).slice().sort((a, b) => a - b).join(","))
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { results: sampled } = await env.DB.prepare(
      "SELECT id, text FROM tweets ORDER BY RANDOM() LIMIT ?"
    ).bind(TWEETS_PER_PARTICIPANT).all();

    if (!sampled || sampled.length < TWEETS_PER_PARTICIPANT) return null;

    const key = sampled.map((t) => t.id).slice().sort((a, b) => a - b).join(",");
    if (!seen.has(key)) return sampled;
  }
  return null;
}

/** Hand a returning participant back their own assignment and progress. */
async function resumeSession(participant, displayName, env) {
  const assigned = JSON.parse(participant.assigned_ids);

  if (displayName) {
    await env.DB.prepare("UPDATE participants SET display_name = ? WHERE id = ?")
      .bind(displayName, participant.id).run();
  }

  const placeholders = assigned.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT id, text FROM tweets WHERE id IN (${placeholders})`
  ).bind(...assigned).all();

  // Keep the order this participant originally saw.
  const byId = new Map((rows ?? []).map((t) => [t.id, t]));
  const tweets = assigned.map((id) => byId.get(id)).filter(Boolean);

  const answered = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM labels WHERE participant_id = ?"
  ).bind(participant.id).first();

  return {
    participantId: participant.id,
    tweets,
    labels: LABELS,
    answered: answered?.n ?? 0,
    completed: Boolean(participant.completed_at),
  };
}

/** Record one decision. Re-labeling the same tweet overwrites the earlier answer. */
async function recordLabel(body, env) {
  const { participantId, tweetId, label, position, dwellMs } = body;

  if (!participantId) return bad("Missing participantId");
  if (!LABELS.includes(label)) return bad("Unknown label");

  const participant = await env.DB.prepare(
    "SELECT assigned_ids FROM participants WHERE id = ?"
  ).bind(participantId).first();
  if (!participant) return bad("Unknown participant", 404);

  // Only accept labels for tweets this participant was actually shown.
  const assigned = JSON.parse(participant.assigned_ids);
  if (!assigned.includes(tweetId)) return bad("Tweet was not assigned to this participant");

  const tweet = await env.DB.prepare(
    "SELECT gold_label FROM tweets WHERE id = ?"
  ).bind(tweetId).first();
  if (!tweet) return bad("Unknown tweet", 404);

  await env.DB.prepare(
    `INSERT INTO labels
       (participant_id, tweet_id, chosen_label, gold_label, is_correct, position, dwell_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (participant_id, tweet_id) DO UPDATE SET
       chosen_label = excluded.chosen_label,
       is_correct   = excluded.is_correct,
       dwell_ms     = excluded.dwell_ms,
       created_at   = excluded.created_at`
  ).bind(
    participantId,
    tweetId,
    label,
    tweet.gold_label,
    label === tweet.gold_label ? 1 : 0,
    Number(position) || 0,
    Number.isFinite(dwellMs) ? Math.round(dwellMs) : null,
    new Date().toISOString()
  ).run();

  return json({ ok: true });
}

/** Mark the session finished and hand back a small summary for the thank-you screen. */
async function completeSession(body, env) {
  const { participantId } = body;
  if (!participantId) return bad("Missing participantId");

  const { meta } = await env.DB.prepare(
    "UPDATE participants SET completed_at = ? WHERE id = ? AND completed_at IS NULL"
  ).bind(new Date().toISOString(), participantId).run();

  const summary = await env.DB.prepare(
    "SELECT COUNT(*) AS labeled, SUM(is_correct) AS agreed FROM labels WHERE participant_id = ?"
  ).bind(participantId).first();

  return json({
    ok: true,
    alreadyCompleted: meta.changes === 0,
    labeled: summary?.labeled ?? 0,
    agreed: summary?.agreed ?? 0,
  });
}

/* ────────────────────────────── admin ────────────────────────────── */

/** Constant-time string compare, so a wrong password leaks nothing via timing. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

const UNAUTHORIZED = () =>
  new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="admin", charset="UTF-8"' },
  });

async function handleAdmin(url, request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    return new Response(
      "ADMIN_PASSWORD is not set. Run: npx wrangler secret put ADMIN_PASSWORD",
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return UNAUTHORIZED();
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return UNAUTHORIZED();
  }
  // Username is ignored; the password is the whole secret.
  if (!safeEqual(decoded.slice(decoded.indexOf(":") + 1), expected)) return UNAUTHORIZED();

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return new Response(ADMIN_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/admin/data") return json(await collectData(env));
  if (url.pathname === "/admin/labels.csv") return csvResponse(await collectData(env));
  return bad("Not found", 404);
}

/** Everything the dashboard needs, in one round trip. */
async function collectData(env) {
  const [participants, labels, totals] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.display_name, p.started_at, p.completed_at,
              COUNT(l.id) AS labeled, COALESCE(SUM(l.is_correct), 0) AS agreed
       FROM participants p
       LEFT JOIN labels l ON l.participant_id = p.id
       GROUP BY p.id
       ORDER BY p.started_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT l.participant_id, p.display_name, l.position, l.tweet_id, t.text,
              l.chosen_label, l.gold_label, l.is_correct, l.dwell_ms, l.created_at
       FROM labels l
       JOIN participants p ON p.id = l.participant_id
       JOIN tweets t       ON t.id = l.tweet_id
       ORDER BY l.created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM tweets)       AS tweets,
              (SELECT COUNT(*) FROM participants) AS participants,
              (SELECT COUNT(*) FROM participants WHERE completed_at IS NOT NULL) AS completed,
              (SELECT COUNT(*) FROM labels)       AS labels,
              (SELECT COALESCE(SUM(is_correct), 0) FROM labels) AS agreed`
    ).first(),
  ]);

  return {
    totals,
    participants: participants.results,
    labels: labels.results,
    categories: LABELS,
  };
}

function csvResponse(data) {
  const cols = ["participant_id", "display_name", "position", "tweet_id", "text",
                "chosen_label", "gold_label", "is_correct", "dwell_ms", "created_at"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const rows = data.labels.map((r) => cols.map((c) => esc(r[c])).join(","));
  return new Response([cols.join(","), ...rows].join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="labels.csv"',
    },
  });
}
