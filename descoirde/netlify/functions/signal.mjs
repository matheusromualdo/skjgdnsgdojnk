import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "vibe-signals", consistency: "strong" });
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const safe = (value, max = 60) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, max);

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const room = safe(body.room, 40);
  const clientId = safe(body.clientId, 60);
  if (!room || !clientId || !["join", "poll", "send", "leave"].includes(body.action)) {
    return json({ error: "Invalid request" }, 400);
  }
  const db = store();
  const presencePrefix = `r:${room}:p:`;
  const eventPrefix = `r:${room}:e:`;
  const presenceKey = `${presencePrefix}${clientId}`;
  const now = Date.now();

  if (body.action === "leave") {
    await db.delete(presenceKey);
    const seq = `${String(now).padStart(13, "0")}-${crypto.randomUUID()}`;
    await db.set(`${eventPrefix}${seq}`, JSON.stringify({ seq, from: clientId, kind: "leave", at: now }));
    return json({ ok: true });
  }

  if (body.action === "join") {
    const entries = await db.list({ prefix: presencePrefix });
    const peers = [];
    for (const item of entries.blobs) {
      if (item.key === presenceKey) continue;
      const p = await db.get(item.key, { type: "json" });
      if (p && now - p.at < 30000) peers.push({ id: item.key.slice(presencePrefix.length), name: p.name || "Amigo" });
      else await db.delete(item.key);
    }
    await db.set(presenceKey, JSON.stringify({ name: String(body.name || "Sem nome").slice(0, 30), at: now }));
    const seq = `${String(now).padStart(13, "0")}-${crypto.randomUUID()}`;
    await db.set(`${eventPrefix}${seq}`, JSON.stringify({ seq, from: clientId, kind: "join", name: String(body.name || "Sem nome").slice(0, 30), at: now }));
    return json({ ok: true, peers });
  }

  if (body.action === "send") {
    const to = safe(body.to, 60);
    if (!to || to === clientId || !body.data || JSON.stringify(body.data).length > 100000) return json({ error: "Invalid signal" }, 400);
    const seq = `${String(now).padStart(13, "0")}-${crypto.randomUUID()}`;
    await db.set(`${eventPrefix}${seq}`, JSON.stringify({ seq, from: clientId, to, kind: "signal", data: body.data, at: now }));
    return json({ ok: true });
  }

  await db.set(presenceKey, JSON.stringify({ name: String(body.name || "Sem nome").slice(0, 30), at: now }));
  const listed = await db.list({ prefix: eventPrefix });
  const events = [];
  for (const item of listed.blobs) {
    if (!item.key.startsWith(eventPrefix)) continue;
    const eventId = item.key.slice(eventPrefix.length);
    if (eventId <= String(body.cursor || "")) continue;
    const ev = await db.get(item.key, { type: "json" });
    if (!ev) continue;
    if (now - ev.at > 120000) {
      await db.delete(item.key);
      continue;
    }
    if (ev.kind === "signal" && ev.to !== clientId) continue;
    events.push(ev);
  }
  events.sort((a, b) => a.seq.localeCompare(b.seq));
  return json({ events: events.slice(0, 200) });
};
