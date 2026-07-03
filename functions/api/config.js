// functions/api/config.js
// Cloudflare Pages Function — handles GET /api/config
// Returns the active scoring weights/thresholds so the page's on-screen
// headline score stays in sync with whatever you set in Supabase.
// Non-sensitive: weights and thresholds only — no PII, no keys.
//
// Environment variables required:
//   SUPABASE_URL, SUPABASE_SECRET_KEY

export async function onRequestGet(context) {
  const { env } = context;
  const empty = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/scoring_config?active=eq.true&select=band_points,dimension_weights,band_thresholds&limit=1`,
      { headers: { "apikey": env.SUPABASE_SECRET_KEY, "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}` } }
    );
    if (!r.ok) return empty();
    const rows = await r.json();
    const cfg = rows && rows[0] ? rows[0] : {};
    return new Response(JSON.stringify(cfg), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });
  } catch {
    return empty();
  }
}
