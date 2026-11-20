/* Outgoing typed chat for a call. The bubble is shown at once. If the
   signalling socket is down the message is queued and sent when it opens,
   or marked failed so the person can retry. Incoming ids are remembered
   so a retry cannot play the same message twice. */

export const CHAT_FAIL_MS = 15000;

export function chatId(now, rand) {
  const t = Number(now) || Date.now();
  const r = rand == null ? Math.random() : Number(rand);
  return "c" + t.toString(36) + Math.floor(r * 1e9).toString(36);
}

export function createChatOutbox(opts) {
  const send = opts && opts.send;
  const now = (opts && opts.now) || (() => Date.now());
  const failMs = opts && opts.failMs != null ? opts.failMs : CHAT_FAIL_MS;
  const pending = [];
  const seen = new Set();

  function post(text, lang, id) {
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return null;
    const rowId = id || chatId(now());
    const data = { kind: "chat", text: clean, lang: lang || "", id: rowId };
    const delivered = !!(send && send(data));
    if (!delivered) {
      const rest = pending.filter((row) => row.id !== rowId);
      pending.length = 0;
      rest.concat([{ id: rowId, data: data, at: now() }]).forEach((row) => pending.push(row));
    } else {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].id === rowId) pending.splice(i, 1);
    }
    return { id: rowId, original: clean, sent: delivered, data: data };
  }

  function flush() {
    const sent = [];
    const keep = [];
    pending.splice(0).forEach((row) => {
      if (send && send(row.data)) sent.push(row);
      else keep.push(row);
    });
    keep.forEach((row) => pending.push(row));
    return sent;
  }

  function expire() {
    const cut = now() - failMs;
    const failed = [];
    const keep = [];
    pending.splice(0).forEach((row) => {
      if (row.at <= cut) failed.push(row);
      else keep.push(row);
    });
    keep.forEach((row) => pending.push(row));
    return failed;
  }

  function incoming(data) {
    const id = String((data && data.id) || "");
    if (!id) return data;
    if (seen.has(id)) return null;
    seen.add(id);
    if (seen.size > 80) seen.delete(seen.values().next().value);
    return data;
  }

  function queued() { return pending.slice(); }

  return { post: post, flush: flush, expire: expire, incoming: incoming, queued: queued };
}
