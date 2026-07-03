// functions/api/submit.js
// Cloudflare Pages Function — handles POST /api/submit
// Flow: verify Turnstile → validate input → load live scoring config →
//       score authoritatively → insert the response into Supabase.
//
// Environment variables (set in Cloudflare Pages → Settings → Environment variables,
// NEVER committed to the repo):
//   SUPABASE_URL          e.g. https://xxxxxxxx.supabase.co
//   SUPABASE_SECRET_KEY   the sb_secret_... key (bypasses RLS; server-only)
//   TURNSTILE_SECRET_KEY  the Cloudflare Turnstile secret key

const PROBES_BY_DIM = {
  d1:["d1a","d1b"], d2:["d2a","d2b"], d3:["d3a","d3b"], d4:["d4a","d4b"],
  d5:["d5a","d5b"], d6:["d6a","d6b"], d7:["d7a","d7b"]
};
const ALL_PROBES = Object.values(PROBES_BY_DIM).flat();
const VALID_BANDS = ["foundational","developing","robust","institutional_grade"];
const VALID_ORG_TYPES = ["asset_owner","licensee","advice_practice","platform_operator","other",""];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid request." }, 400); }

  const contact = body.contact || {};
  const answers = body.answers || {};
  const token = body.token || "";

  // --- 1. Validate & sanitise contact (all input treated as untrusted) ---
  const name  = String(contact.name || "").trim().slice(0, 200);
  const email = String(contact.email || "").trim().slice(0, 320);
  const org   = String(contact.organisation || "").trim().slice(0, 200);
  const role  = String(contact.role || "").trim().slice(0, 200);
  const orgType = String(contact.org_type || "").trim();
  const consent = contact.consent === true;

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!name || !emailOk || !org) return json({ ok: false, error: "Missing or invalid contact details." }, 400);
  if (!consent) return json({ ok: false, error: "Consent is required." }, 400);
  if (!VALID_ORG_TYPES.includes(orgType)) return json({ ok: false, error: "Invalid organisation type." }, 400);

  // --- 2. Validate answers (all 13 probes, valid bands only) ---
  for (const p of ALL_PROBES) {
    if (!VALID_BANDS.includes(answers[p])) return json({ ok: false, error: "Incomplete answers." }, 400);
  }

  // --- 3. Verify Turnstile server-side ---
  if (env.TURNSTILE_SECRET_KEY) {
    if (!token) return json({ ok: false, error: "Verification required." }, 400);
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) form.append("remoteip", ip);
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const outcome = await verify.json();
    if (!outcome.success) return json({ ok: false, error: "Verification failed." }, 403);
  }

  // --- 4. Load the active scoring config ---
  const cfg = await loadConfig(env);
  if (!cfg) return json({ ok: false, error: "Scoring temporarily unavailable." }, 500);

  const bandPoints = cfg.band_points, weights = cfg.dimension_weights, thresholds = cfg.band_thresholds;
  const bandFor = s =>
    s >= thresholds.institutional_grade ? "institutional_grade" :
    s >= thresholds.robust ? "robust" :
    s >= thresholds.developing ? "developing" : "foundational";

  // --- 5. Score authoritatively ---
  const dimensionScores = {};
  let tot = 0, wsum = 0;
  for (const [dim, probes] of Object.entries(PROBES_BY_DIM)) {
    const avg = probes.reduce((a, p) => a + (bandPoints[answers[p]] ?? 0), 0) / probes.length;
    dimensionScores[dim] = Math.round(avg * 100) / 100;
    const w = weights[dim] ?? 1;
    tot += avg * w; wsum += w;
  }
  const composite = wsum ? Math.round((tot / wsum) * 100) / 100 : 0;
  const band = bandFor(composite);

  // --- 6. Insert into Supabase (secret key bypasses RLS) ---
  const row = {
    name, email, organisation: org, role, org_type: orgType || null, consent,
    composite_score: composite, band,
    dimension_scores: dimensionScores,
    raw_answers: answers,
    source: (typeof body.source === "string" ? body.source.slice(0, 200) : null)
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/scorecard_responses`, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SECRET_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) return json({ ok: false, error: "Could not save your response." }, 502);

  return json({ ok: true, band, composite, dimension_scores: dimensionScores });
}

async function loadConfig(env) {
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/scoring_config?active=eq.true&select=band_points,dimension_weights,band_thresholds&limit=1`,
      { headers: { "apikey": env.SUPABASE_SECRET_KEY, "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}
