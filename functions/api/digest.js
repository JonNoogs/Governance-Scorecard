// functions/api/digest.js
// Cloudflare Pages Function — handles GET /api/digest
//
// Returns recent scorecard responses as JSON, for the daily digest script.
// Exists because Supabase's secret keys are rejected when the request looks
// like it came from a browser (Apps Script sends a Mozilla/5.0 User-Agent).
// A Pages Function is a trusted server environment, so the call succeeds here
// — and the Supabase secret key stays in exactly one place: Cloudflare.
//
// Protected by a shared token sent in the X-Digest-Token header.
//
// Environment variables required (Cloudflare Pages → Settings → Variables):
//   SUPABASE_URL          already set
//   SUPABASE_SECRET_KEY   already set
//   DIGEST_TOKEN          NEW — a long random string you generate

const FIELDS = "created_at,name,email,organisation,role,org_type,band,composite_score,dimension_scores";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });

export async function onRequestGet(context) {
  const { request, env } = context;

  // --- Authorise ---------------------------------------------------
  // Token travels in a header, never a query string, because this
  // endpoint returns personal information.
  const supplied = request.headers.get("X-Digest-Token") || "";
  if (!env.DIGEST_TOKEN || supplied !== env.DIGEST_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }

  // --- How far back? (default 24h, capped at 90 days) ---------------
  const url = new URL(request.url);
  let hours = parseInt(url.searchParams.get("hours") || "24", 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = 24;
  hours = Math.min(hours, 24 * 90);

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // --- Fetch from Supabase -----------------------------------------
  const endpoint = `${env.SUPABASE_URL}/rest/v1/scorecard_responses`
    + `?select=${FIELDS}`
    + `&created_at=gte.${encodeURIComponent(since)}`
    + `&order=created_at.desc`;

  const res = await fetch(endpoint, {
    headers: {
      "apikey": env.SUPABASE_SECRET_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SECRET_KEY}`
    }
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "Upstream error", status: res.status, detail: detail.slice(0, 300) }, 502);
  }

  const rows = await res.json();
  return json({ ok: true, hours, count: rows.length, rows });
}
