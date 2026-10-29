// van-rinks: one-page view of Vancouver drop-in rink schedules.
// Proxies the ActiveNet calendar API (no CORS upstream) and renders the next N days.

const UPSTREAM =
  "https://anc.ca.apm.activecommunities.com/vancouver/rest/onlinecalendar/multicenter/events?locale=en-US";
const CALENDAR_ID = 3; // "Drop-in Calendars" > rinks
const CENTER_IDS = [24, 22, 23, 25, 26, 27, 28, 9];
const TZ = "America/Vancouver";
const CACHE_TTL = 3600;

const RINKS: Record<number, { name: string; slug: string }> = {
  24: { name: "Britannia", slug: "britannia" },
  22: { name: "Hillcrest", slug: "hillcrest" },
  23: { name: "Kerrisdale", slug: "kerrisdale" },
  25: { name: "Killarney", slug: "killarney" },
  26: { name: "Kitsilano", slug: "kits" },
  27: { name: "Sunset", slug: "sunset" },
  28: { name: "Trout Lake", slug: "troutlake" },
  9: { name: "West End", slug: "westend" },
};

type Kind = "skate" | "hockey" | "stick" | "figure";

type Session = {
  rink: string;
  slug: string;
  title: string;
  kind: Kind;
  date: string; // YYYY-MM-DD (Vancouver local)
  start: string; // HH:MM
  end: string;
  price: string;
  url: string;
};

type UpstreamEvent = {
  title: string;
  start_time: string;
  end_time: string;
  activity_detail_url: string;
  price?: { estimate_price?: string; free?: boolean };
};

type Upstream = {
  body: { center_events: { center_id: number; events: UpstreamEvent[] }[] };
};

function classify(title: string): Kind {
  const t = title.toLowerCase();
  if (t.includes("stick, puck")) return "stick";
  if (t.includes("hockey")) return "hockey";
  if (t.includes("figure")) return "figure";
  return "skate";
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\|/g, "")
    .replace(/^[A-Za-z ]+ Arena\s*-\s*/, "")
    .replace(/\s*-\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+[\d:]+\s*[ap]m\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchUpstream(): Promise<Session[]> {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "van-rinks/1.0" },
    body: JSON.stringify({
      calendar_id: CALENDAR_ID,
      center_ids: CENTER_IDS,
      display_all: 0,
      search_start_time: "",
      search_end_time: "",
      facility_ids: [],
      activity_ids: [],
      event_type_ids: [],
    }),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const data = (await res.json()) as Upstream;

  const out: Session[] = [];
  for (const c of data.body.center_events) {
    const rink = RINKS[c.center_id];
    if (!rink) continue;
    for (const e of c.events) {
      if (/goalies/i.test(e.title)) continue; // duplicate of the skater slot
      const [date, st] = e.start_time.split(" ");
      const [, et] = e.end_time.split(" ");
      out.push({
        rink: rink.name,
        slug: rink.slug,
        title: cleanTitle(e.title),
        kind: classify(e.title),
        date,
        start: st.slice(0, 5),
        end: et.slice(0, 5),
        price: e.price?.free ? "Free" : e.price?.estimate_price ?? "",
        url: e.activity_detail_url,
      });
    }
  }
  out.sort((a, b) => (a.date + a.start + a.rink).localeCompare(b.date + b.start + b.rink));
  return out;
}

async function getSessions(req: Request, ctx: ExecutionContext): Promise<Session[]> {
  const cache = caches.default;
  const key = new Request(new URL("/__sessions", req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const sessions = await fetchUpstream();
  const resp = new Response(JSON.stringify(sessions), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_TTL}` },
  });
  ctx.waitUntil(cache.put(key, resp.clone()));
  return sessions;
}

function localDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayLabel(ymd: string, today: string): string {
  if (ymd === today) return "Today";
  if (ymd === addDays(today, 1)) return "Tomorrow";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const KINDS: { key: Kind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "skate", label: "Skate" },
  { key: "hockey", label: "Hockey" },
  { key: "stick", label: "Stick & puck" },
  { key: "figure", label: "Figure" },
];

function render(sessions: Session[], q: { type: string; rink: string; days: number }, now: Date): string {
  const today = localDate(now);
  const nowHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const last = addDays(today, q.days - 1);

  const filtered = sessions.filter(
    (s) =>
      s.date >= today &&
      s.date <= last &&
      (q.type === "all" || s.kind === q.type) &&
      (q.rink === "all" || s.slug === q.rink) &&
      !(s.date === today && s.end <= nowHM),
  );

  const byDay = new Map<string, Session[]>();
  for (const s of filtered) (byDay.get(s.date) ?? byDay.set(s.date, []).get(s.date)!).push(s);

  const link = (p: Partial<typeof q>) => {
    const u = new URLSearchParams();
    const t = p.type ?? q.type, r = p.rink ?? q.rink, d = p.days ?? q.days;
    if (t !== "all") u.set("type", t);
    if (r !== "all") u.set("rink", r);
    if (d !== 7) u.set("days", String(d));
    const s = u.toString();
    return s ? `/?${s}` : "/";
  };

  const chips = (items: { key: string; label: string }[], cur: string, k: "type" | "rink") =>
    items
      .map((i) => `<a class="chip${i.key === cur ? " on" : ""}" href="${link({ [k]: i.key })}">${esc(i.label)}</a>`)
      .join("");

  const rinkChips = [{ key: "all", label: "All rinks" }, ...Object.values(RINKS).map((r) => ({ key: r.slug, label: r.name }))];

  const days = [...byDay.entries()]
    .map(
      ([d, list]) => `
<section>
  <h2>${esc(dayLabel(d, today))}<span class="sub">${d}</span></h2>
  ${list
    .map(
      (s) => `
  <a class="row k-${s.kind}" href="${esc(s.url)}" target="_blank" rel="noopener">
    <span class="time">${fmtTime(s.start)}<small>–${fmtTime(s.end)}</small></span>
    <span class="what"><b>${esc(s.title)}</b><span class="rink">${esc(s.rink)}</span></span>
    <span class="price">${esc(s.price)}</span>
  </a>`,
    )
    .join("")}
</section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Vancouver rinks</title>
<style>
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#e5e5e5;--chip:#f2f2f2;--on:#111;--onfg:#fff;
 --skate:#2563eb;--hockey:#dc2626;--stick:#d97706;--figure:#7c3aed}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#2a2a2a;--chip:#222;--on:#eee;--onfg:#111}}
*{box-sizing:border-box}
body{margin:0;padding:16px;max-width:680px;margin-inline:auto;font:15px/1.4 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{padding:6px 11px;border-radius:999px;background:var(--chip);color:var(--fg);text-decoration:none;font-size:13px}
.chip.on{background:var(--on);color:var(--onfg)}
h2{font-size:15px;margin:22px 0 6px;display:flex;align-items:baseline;gap:8px}
h2 .sub{font-weight:400;color:var(--mut);font-size:12px}
.row{display:grid;grid-template-columns:92px 1fr auto;gap:10px;align-items:center;padding:10px 0 10px 10px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none;border-left:3px solid var(--c,var(--mut))}
.row:hover b{text-decoration:underline}
.time{font-variant-numeric:tabular-nums;font-weight:600}
.time small{display:block;font-weight:400;color:var(--mut);font-size:12px}
.what{display:flex;flex-direction:column;min-width:0}
.what b{font-weight:600}
.rink{color:var(--mut);font-size:13px}
.price{color:var(--mut);font-size:13px;white-space:nowrap}
.k-skate{--c:var(--skate)}.k-hockey{--c:var(--hockey)}.k-stick{--c:var(--stick)}.k-figure{--c:var(--figure)}
.empty{color:var(--mut);padding:40px 0;text-align:center}
footer{margin-top:32px;color:var(--mut);font-size:12px}
footer a{color:inherit}
</style>
</head>
<body>
<h1>Vancouver rinks</h1>
<div class="chips">${chips(KINDS, q.type, "type")}</div>
<div class="chips">${chips(rinkChips, q.rink, "rink")}</div>
${days || `<p class="empty">Nothing scheduled for this filter in the next ${q.days} days.</p>`}
<footer>Next ${q.days} days · <a href="${link({ days: q.days === 7 ? 14 : 7 })}">${q.days === 7 ? "show 14" : "show 7"}</a> · <a href="/api.json">JSON</a> · cached 1h from
<a href="https://anc.ca.apm.activecommunities.com/vancouver/calendars?defaultCalendarId=3&locationId=24,22,23,25,26,27,28,9&displayType=0&view=2">vancouver.ca drop-in calendar</a></footer>
</body>
</html>`;
}

// ---------- MCP (Streamable HTTP, stateless) ----------

const MCP_TOOLS = [
  {
    name: "list_rink_sessions",
    description:
      "Drop-in sessions at Vancouver city rinks (public skate, hockey, stick & puck, figure). Times are Vancouver local. Defaults to the next 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["all", "skate", "hockey", "stick", "figure"], description: "Session kind (default all)" },
        rink: {
          type: "string",
          enum: ["all", ...Object.values(RINKS).map((r) => r.slug)],
          description: "Rink slug (default all)",
        },
        days: { type: "integer", minimum: 1, maximum: 30, description: "How many days ahead from today (default 7)" },
        date: { type: "string", description: "A single date YYYY-MM-DD; overrides days" },
      },
    },
  },
  {
    name: "list_rinks",
    description: "The eight Vancouver city rinks and the slug to use in list_rink_sessions.",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleMcp(req: Request, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpc(null, undefined, { code: -32700, message: "Parse error" });
  }
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return rpc(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "van-rinks", version: "1.0.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const a = params?.arguments ?? {};
      if (params?.name === "list_rinks") {
        const text = Object.values(RINKS).map((r) => `${r.slug}: ${r.name}`).join("\n");
        return rpc(id, { content: [{ type: "text", text }] });
      }
      if (params?.name === "list_rink_sessions") {
        const sessions = await getSessions(req, ctx);
        const now = new Date();
        const today = localDate(now);
        const nowHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
        const type = a.type ?? "all", rink = a.rink ?? "all";
        const from = a.date ?? today;
        const to = a.date ?? addDays(today, Math.min(30, Math.max(1, Number(a.days) || 7)) - 1);
        const list = sessions.filter(
          (s) =>
            s.date >= from && s.date <= to &&
            (type === "all" || s.kind === type) &&
            (rink === "all" || s.slug === rink) &&
            !(s.date === today && s.end <= nowHM),
        );
        const lines = list.map(
          (s) => `${s.date} ${dayLabel(s.date, today).split(",")[0]} ${fmtTime(s.start)}-${fmtTime(s.end)} | ${s.rink} | ${s.title} [${s.kind}]${s.price ? " " + s.price : ""} | ${s.url}`,
        );
        const text = lines.length ? lines.join("\n") : `No ${type} sessions at ${rink} between ${from} and ${to}.`;
        return rpc(id, { content: [{ type: "text", text }], structuredContent: { sessions: list } });
      }
      return rpc(id, undefined, { code: -32602, message: `Unknown tool ${params?.name}` });
    }
    default:
      return rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

export default {
  async fetch(req: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return handleMcp(req, ctx);
    const sessions = await getSessions(req, ctx);

    if (url.pathname === "/api.json") {
      return new Response(JSON.stringify(sessions), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=600" },
      });
    }
    if (url.pathname !== "/") return new Response("not found", { status: 404 });

    const type = url.searchParams.get("type") ?? "all";
    const rink = url.searchParams.get("rink") ?? "all";
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    const html = render(sessions, { type, rink, days }, new Date());
    return new Response(html, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};
