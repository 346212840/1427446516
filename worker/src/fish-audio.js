/* Owner-only proxy for Fish Audio. The API key stays in FISH_AUDIO_API_KEY.
   The browser never sees it. Docs: https://docs.fish.audio (POST /v1/tts, GET /model).
   Listing voices never calls /v1/tts. previewUrl is the model's own sample. */

const FISH = "https://api.fish.audio";
const TEXT_MAX = 2000;
const TTS_LIMIT = 12;
const LIST_LIMIT = 40;
const WINDOW = 60 * 60 * 1000;
const LIST_WINDOW = 10 * 60 * 1000;
const AUDIO_MAX = 15 * 1024 * 1024;

function keyOf(env) {
  return String(env && env.FISH_AUDIO_API_KEY || "").trim();
}

function configured(env) {
  return !!keyOf(env);
}

export function cleanVoiceId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : "";
}

export function cleanTtsBody(body) {
  const text = String(body && body.text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!text || text.length > TEXT_MAX) return { error: "bad_text" };
  const referenceId = cleanVoiceId(body && (body.referenceId || body.reference_id));
  if (!referenceId) return { error: "bad_voice" };
  const format = ["opus", "mp3", "wav"].includes(body && body.format) ? body.format : "opus";
  let speed = Number(body && body.speed);
  if (!Number.isFinite(speed)) speed = 1;
  speed = Math.round(Math.min(2, Math.max(0.5, speed)) * 100) / 100;
  const latency = ["low", "normal", "balanced"].includes(body && body.latency) ? body.latency : "normal";
  return { text, referenceId, format, speed, latency };
}

function sampleUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); }
  catch (err) { return ""; }
  if (url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (host !== "fish.audio" && !host.endsWith(".fish.audio")) return "";
  return url.toString();
}

function publicVoice(item) {
  const id = cleanVoiceId(item && (item._id || item.id));
  if (!id) return null;
  const samples = Array.isArray(item.samples) ? item.samples : [];
  const preview = samples.map((row) => sampleUrl(row && row.audio)).find(Boolean) || "";
  return {
    id,
    title: String(item.title || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 80),
    previewUrl: preview
  };
}

async function fish(env, fetchImpl, path, init) {
  const headers = new Headers(init && init.headers || {});
  headers.set("Authorization", "Bearer " + keyOf(env));
  return fetchImpl(FISH + path, Object.assign({}, init, { headers }));
}

function mapped(status) {
  if (status === 401) return { status: 503, error: "not_configured" };
  if (status === 402) return { status: 402, error: "quota" };
  if (status === 429) return { status: 429, error: "rate_limited" };
  if (status === 503) return { status: 503, error: "busy" };
  return { status: 502, error: "fish_failed" };
}

export async function handleFish(request, env, path, deps) {
  const json = deps.json;
  const gate = await deps.requireOwner(request, env);
  if (gate.error) return gate.error;
  const ownerId = String(gate.row.public_id || "owner");
  const fetchImpl = typeof deps.fetch === "function" ? deps.fetch : fetch;

  if (path === "/v1/owner/fish" && request.method === "GET") {
    return json(200, { configured: configured(env) });
  }

  if (!configured(env)) return json(503, { error: "not_configured" });

  if (path === "/v1/owner/fish/voices" && request.method === "GET") {
    const hit = await deps.rateHit(env, "fish:list:" + ownerId, LIST_LIMIT, LIST_WINDOW);
    if (!hit.ok) return deps.limited(hit);
    const url = new URL(request.url);
    const page = Math.max(1, Math.min(20, Number(url.searchParams.get("page")) || 1));
    const title = String(url.searchParams.get("q") || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 60);
    const query = new URLSearchParams({ self: "true", page_size: "20", page_number: String(page) });
    if (title) query.set("title", title);
    const res = await fish(env, fetchImpl, "/model?" + query.toString(), { method: "GET" });
    if (!res.ok) {
      const err = mapped(res.status);
      return json(err.status, { error: err.error });
    }
    const body = await res.json().catch(() => null);
    const voices = [];
    for (const item of (body && body.items) || []) {
      const row = publicVoice(item);
      if (row) voices.push(row);
    }
    return json(200, { configured: true, voices, hasMore: !!(body && body.has_more) });
  }

  if (path === "/v1/owner/fish/tts" && request.method === "POST") {
    const hit = await deps.rateHit(env, "fish:tts:" + ownerId, TTS_LIMIT, WINDOW);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 8000);
    if (!body || body.error) return json(400, { error: "bad_text" });
    const clean = cleanTtsBody(body);
    if (clean.error) return json(400, { error: clean.error });
    const res = await fish(env, fetchImpl, "/v1/tts", {
      method: "POST",
      headers: { "content-type": "application/json", model: "s2.1-pro" },
      body: JSON.stringify({
        text: clean.text,
        reference_id: clean.referenceId,
        format: clean.format,
        latency: clean.latency,
        prosody: { speed: clean.speed, volume: 0 }
      })
    });
    if (!res.ok) {
      const err = mapped(res.status);
      return json(err.status, { error: err.error });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > AUDIO_MAX) return json(413, { error: "too_large" });
    const mime = clean.format === "wav" ? "audio/wav" : clean.format === "opus" ? "audio/ogg" : "audio/mpeg";
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }

  return json(405, { error: "method" });
}
