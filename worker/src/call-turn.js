/* Cloudflare Realtime TURN safeguards for Calls.

   TURN is only a fallback: browsers try a direct path first and use a relayed
   candidate only when that fails, so most calls never touch it. These rules
   keep it inside the free allowance (1,000 GB a month) even so:

   - credentials go only to someone taking part in a live call (host, callee or
     a guest of that call), at most a few times per person and per call, and
     last two hours;
   - the Worker keeps a conservative estimate of relayed traffic per call in D1
     (a small amount when a call starts ringing, a larger one once it is
     answered, then call length times a high audio rate when it ends) and stops
     issuing credentials at a soft cap of 300 GB for the calendar month (UTC),
     which resets by itself;
   - when the cap is reached, or anything else says no, the call keeps working
     with the free public relay on port 443.

   Cloudflare's own usage numbers need an account API token the Worker does not
   hold (the TURN key token cannot read analytics), so this is an estimate. */

export const TURN_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_CAP_BYTES = 300 * 1000 * 1000 * 1000;
export const MAX_CAP_BYTES = 600 * 1000 * 1000 * 1000;
/* Opus with overhead, generously, in both directions through the relay. */
export const BYTES_PER_SECOND = 32000;
export const RING_RESERVE = 5 * 1000 * 1000;
export const ACTIVE_RESERVE = 20 * 60 * BYTES_PER_SECOND;
export const PER_USER = { max: 30, windowMs: 60 * 60 * 1000 };
export const PER_CALL = { max: 8, windowMs: 60 * 60 * 1000 };

export const TURN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_turn (
    call_id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    reserved INTEGER NOT NULL,
    issued INTEGER NOT NULL DEFAULT 1,
    settled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS call_turn_month ON call_turn (month)`
];

export function monthKey(now) {
  const d = new Date(Number(now) || Date.now());
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

export function capBytes(env) {
  const gb = Number(env && env.CALLS_TURN_CAP_GB);
  if (!(gb > 0)) return DEFAULT_CAP_BYTES;
  return Math.min(MAX_CAP_BYTES, Math.round(gb * 1000 * 1000 * 1000));
}

export function estimateBytes(durationMs) {
  return Math.max(0, Math.round((Number(durationMs) || 0) / 1000) * BYTES_PER_SECOND);
}

export async function turnUsage(env, now) {
  const month = monthKey(now);
  const row = await env.DB.prepare("SELECT COALESCE(SUM(reserved), 0) AS bytes, COUNT(*) AS calls FROM call_turn WHERE month = ?").bind(month).first();
  return { month: month, bytes: Number((row && row.bytes) || 0), calls: Number((row && row.calls) || 0) };
}

/* ctx: { id, self, state }. Returns the Cloudflare ICE servers to add, or [] with a reason. */
export async function mintTurn(env, deps, ctx, now) {
  const keyId = String((env && env.CF_TURN_KEY_ID) || "");
  const token = String((env && env.CF_TURN_API_TOKEN) || "");
  if (!keyId || !token) return { servers: [], reason: "unconfigured" };
  if (!ctx || !ctx.id || !ctx.self) return { servers: [], reason: "no_call" };
  if (ctx.state !== "ringing" && ctx.state !== "active") return { servers: [], reason: "inactive" };
  const at = Number(now) || Date.now();
  if (!ctx.budgetOff) {
    const used = await turnUsage(env, at);
    if (used.bytes >= capBytes(env)) return { servers: [], reason: "cap" };
  }
  const user = await deps.rateHit(env, "turn:" + ctx.self, PER_USER.max, PER_USER.windowMs);
  if (!user.ok) return { servers: [], reason: "rate" };
  const call = await deps.rateHit(env, "turncall:" + ctx.id, PER_CALL.max, PER_CALL.windowMs);
  if (!call.ok) return { servers: [], reason: "rate" };
  let servers = [];
  try {
    const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(keyId) + "/credentials/generate-ice-servers", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS })
    });
    if (res.ok) {
      const data = await res.json();
      servers = (Array.isArray(data.iceServers) ? data.iceServers : []).filter((row) => row && row.urls && row.credential);
    }
  } catch (err) { servers = []; }
  if (!servers.length) return { servers: [], reason: "upstream" };
  const reserve = ctx.state === "active" ? ACTIVE_RESERVE : RING_RESERVE;
  await env.DB.prepare("INSERT INTO call_turn (call_id, month, reserved, issued, settled, updated_at) VALUES (?, ?, ?, 1, 0, ?) ON CONFLICT(call_id) DO UPDATE SET reserved = MAX(reserved, excluded.reserved), issued = issued + 1, updated_at = excluded.updated_at WHERE settled = 0").bind(ctx.id, monthKey(at), reserve, at).run();
  return { servers: servers, reason: "ok" };
}

/* When a call ends its reservation becomes call length at the high rate (nothing if it was never answered). */
export async function settleTurn(env, callId, durationMs, now) {
  await env.DB.prepare("UPDATE call_turn SET reserved = ?, settled = 1, updated_at = ? WHERE call_id = ? AND settled = 0").bind(estimateBytes(durationMs), Number(now) || Date.now(), callId).run();
}

export async function turnStatus(env, now) {
  const used = await turnUsage(env, now);
  const cap = capBytes(env);
  return {
    month: used.month,
    usedBytes: used.bytes,
    capBytes: cap,
    percent: Math.min(100, Math.round((used.bytes / cap) * 1000) / 10),
    calls: used.calls,
    configured: !!(String((env && env.CF_TURN_KEY_ID) || "") && String((env && env.CF_TURN_API_TOKEN) || "")),
    capped: used.bytes >= cap,
    estimate: true
  };
}
