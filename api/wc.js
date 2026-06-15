// Serverless function (runs on Vercel) that powers the tracker.
//
// 1. Pulls World Cup group standings + fixtures from football-data.org (key stays server-side).
// 2. Optionally pulls per-match betting odds from The Odds API and SIMULATES the rest of each
//    group to estimate every team's chance of reaching the knockout stage (top 2, or a best-third spot).
// 3. Optionally records a snapshot of that split after each game, to a Redis store, for the history graph.

const COMP = "WC";
const BASE = "https://api.football-data.org/v4";

let cache = { at: 0, data: null };
const TTL_MS = 60 * 1000;

// ---- loose team-name matching (bridges football-data <-> The Odds API spellings) ----
const ALIASES = {
  southkorea: "korea", korearepublic: "korea", korea: "korea",
  czechrepublic: "czech", czechia: "czech",
  ivorycoast: "ivory", cotedivoire: "ivory", cotdivoire: "ivory",
  turkey: "turkey", turkiye: "turkey",
  iran: "iran", iriran: "iran",
  bosnia: "bosnia", bosniaandherzegovina: "bosnia", bosniaherzegovina: "bosnia",
  congodr: "drcongo", drcongo: "drcongo", democraticrepublicofthecongo: "drcongo", congo: "drcongo",
  usa: "usa", unitedstates: "usa", unitedstatesofamerica: "usa", us: "usa",
  capeverde: "capeverde", caboverde: "capeverde", capeverdeislands: "capeverde", cv: "capeverde",
  curacao: "curacao", southafrica: "southafrica",
};
function norm(s) {
  let x = (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[x] || x;
}

// ---- Match odds (The Odds API) ----
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const ODDS_TTL_MS = 3 * 60 * 60 * 1000;
let oddsCache = { at: 0, data: null };

async function fetchMatchOdds(key, force) {
  if (!key) return { available: false, reason: "no_key" };
  const now = Date.now();
  if (!force && oddsCache.data && now - oddsCache.at < ODDS_TTL_MS) return oddsCache.data;
  try {
    const url = ODDS_BASE + "/sports/soccer_fifa_world_cup/odds" +
      "?regions=uk&markets=h2h&oddsFormat=decimal&apiKey=" + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      return { available: false,
        reason: r.status === 401 ? "bad_key" : r.status === 422 ? "market_unavailable" : "error",
        status: r.status, detail: t.slice(0, 200) };
    }
    const arr = await r.json();
    const events = [];
    for (const ev of (Array.isArray(arr) ? arr : [])) {
      const home = ev.home_team, away = ev.away_team;
      if (!home || !away) continue;
      const sum = {}, cnt = {};
      for (const bk of (ev.bookmakers || [])) {
        for (const mk of (bk.markets || [])) {
          if (mk.key !== "h2h") continue;
          for (const oc of (mk.outcomes || [])) {
            if (!oc.price || oc.price <= 1) continue;
            sum[oc.name] = (sum[oc.name] || 0) + 1 / oc.price;
            cnt[oc.name] = (cnt[oc.name] || 0) + 1;
          }
        }
      }
      const ph = sum[home] ? sum[home] / cnt[home] : null;
      const pa = sum[away] ? sum[away] / cnt[away] : null;
      const pd = sum["Draw"] ? sum["Draw"] / cnt["Draw"] : null;
      if (ph == null || pa == null || pd == null) continue;
      const tot = ph + pa + pd;
      events.push({ home, away, pHome: ph / tot, pDraw: pd / tot, pAway: pa / tot });
    }
    const data = events.length
      ? { available: true, updated: new Date().toISOString(), events, source: "the-odds-api.com" }
      : { available: false, reason: "no_events" };
    if (data.available) oddsCache = { at: now, data };
    return data;
  } catch (e) {
    return { available: false, reason: "exception", detail: String(e).slice(0, 200) };
  }
}

// ---- Monte Carlo: chance each team reaches the knockouts ----
function simulateAdvance(groups, events, remaining) {
  const G = groups.map((g) => g.table.map((t) => ({ name: t.name, key: norm(t.name), pts: t.points || 0, gd: t.gd || 0 })));
  const keyToGroup = {}, keyToName = {};
  G.forEach((arr, gi) => arr.forEach((t) => { keyToGroup[t.key] = gi; keyToName[t.key] = t.name; }));

  const pair = {};
  for (const ev of events) {
    const h = norm(ev.home), a = norm(ev.away);
    pair[h + "|" + a] = { h, a, ph: ev.pHome, pd: ev.pDraw, pa: ev.pAway };
  }
  const probFor = (x, y) => {
    const d = pair[x + "|" + y];
    if (d) return { px: d.ph, pd: d.pd, py: d.pa };
    const e = pair[y + "|" + x];
    if (e) return { px: e.pa, pd: e.pd, py: e.ph };
    return { px: 0.36, pd: 0.28, py: 0.36 }; // fallback when a fixture has no odds yet
  };

  const fixtures = [];
  for (const m of remaining) {
    const a = norm(m.home), b = norm(m.away);
    const gi = keyToGroup[a];
    if (gi === undefined || keyToGroup[b] !== gi) continue; // group matches only
    const pr = probFor(a, b);
    fixtures.push({ a, b, pa: pr.px, pd: pr.pd, pb: pr.py });
  }

  const N = 4000;
  const adv = {};
  G.forEach((arr) => arr.forEach((t) => (adv[t.key] = 0)));
  const basePts = {}, gd = {};
  G.forEach((arr) => arr.forEach((t) => { basePts[t.key] = t.pts; gd[t.key] = t.gd; }));

  for (let s = 0; s < N; s++) {
    const pts = {};
    for (const k in basePts) pts[k] = basePts[k];
    for (const f of fixtures) {
      const r = Math.random();
      if (r < f.pa) pts[f.a] += 3;
      else if (r < f.pa + f.pd) { pts[f.a] += 1; pts[f.b] += 1; }
      else pts[f.b] += 3;
    }
    const thirds = [];
    for (let gi = 0; gi < G.length; gi++) {
      const arr = G[gi].slice().sort((x, y) =>
        (pts[y.key] - pts[x.key]) || (gd[y.key] - gd[x.key]) || (Math.random() - 0.5));
      if (arr[0]) adv[arr[0].key]++;
      if (arr[1]) adv[arr[1].key]++;
      if (arr[2]) thirds.push({ key: arr[2].key, pts: pts[arr[2].key], gd: gd[arr[2].key] });
    }
    thirds.sort((x, y) => (y.pts - x.pts) || (y.gd - x.gd) || (Math.random() - 0.5));
    for (let i = 0; i < 8 && i < thirds.length; i++) adv[thirds[i].key]++;
  }

  const teamProb = {};
  for (const k in adv) teamProb[keyToName[k]] = adv[k] / N;
  return teamProb;
}

// ---- Optional: persistent history (Vercel KV / Upstash Redis via REST) ----
function getStore() {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}
const HISTORY_KEY = "advance-history";
async function loadHistory(store) {
  try {
    const r = await fetch(store.base + "/get/" + HISTORY_KEY, { headers: { Authorization: "Bearer " + store.token } });
    if (!r.ok) return [];
    const j = await r.json();
    if (!j || !j.result) return [];
    const arr = JSON.parse(j.result);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
async function saveHistory(store, arr) {
  try {
    await fetch(store.base + "/set/" + HISTORY_KEY, {
      method: "POST",
      headers: { Authorization: "Bearer " + store.token, "Content-Type": "text/plain" },
      body: JSON.stringify(arr),
    });
  } catch (e) { /* ignore */ }
}
function roundProbs(o) { const r = {}; for (const k in o) r[k] = Math.round(o[k] * 1e4) / 1e4; return r; }

function buildAdvance(groups, mo, remaining) {
  return mo.available
    ? { available: true, updated: mo.updated, source: mo.source, kind: "advance", teamProb: simulateAdvance(groups, mo.events, remaining) }
    : mo;
}

export default async function handler(req, res) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    res.status(500).json({ error: "missing_token",
      message: "No API key found. Add FOOTBALL_DATA_TOKEN in Vercel settings, then redeploy." });
    return;
  }

  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) {
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json({ ...cache.data, cached: true });
    return;
  }

  try {
    const headers = { "X-Auth-Token": token };
    const [standingsRes, matchesRes] = await Promise.all([
      fetch(`${BASE}/competitions/${COMP}/standings`, { headers }),
      fetch(`${BASE}/competitions/${COMP}/matches`, { headers }),
    ]);

    if (!standingsRes.ok || !matchesRes.ok) {
      const status = !standingsRes.ok ? standingsRes.status : matchesRes.status;
      res.status(502).json({ error: "upstream_error", status,
        message: status === 403 ? "The API rejected the key. Check FOOTBALL_DATA_TOKEN."
          : status === 429 ? "Hit the free-tier rate limit (10/min). Wait a minute and refresh."
          : "The football data service returned an error." });
      return;
    }

    const standings = await standingsRes.json();
    const matches = await matchesRes.json();

    const groups = (standings.standings || [])
      .filter((s) => s.type === "TOTAL" && s.group)
      .map((s) => ({
        group: s.group,
        table: (s.table || []).map((row) => ({
          position: row.position,
          name: row.team?.name || "",
          shortName: row.team?.shortName || row.team?.tla || row.team?.name || "",
          crest: row.team?.crest || "",
          played: row.playedGames, won: row.won, draw: row.draw, lost: row.lost,
          gf: row.goalsFor, ga: row.goalsAgainst, gd: row.goalDifference, points: row.points,
        })),
      }));

    const trimmedMatches = (matches.matches || [])
      .map((m) => ({
        id: m.id, utcDate: m.utcDate, status: m.status, stage: m.stage, group: m.group || null,
        home: m.homeTeam?.name || "TBD", homeCrest: m.homeTeam?.crest || "",
        away: m.awayTeam?.name || "TBD", awayCrest: m.awayTeam?.crest || "",
        homeScore: m.score?.fullTime?.home, awayScore: m.score?.fullTime?.away, winner: m.score?.winner || null,
      }))
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    const finishedCount = trimmedMatches.filter((m) => m.status === "FINISHED").length;
    const remaining = trimmedMatches.filter((m) => m.status !== "FINISHED");

    let mo = await fetchMatchOdds(process.env.THE_ODDS_API_KEY);
    let oddsData = buildAdvance(groups, mo, remaining);

    const store = getStore();
    let history;
    if (store) {
      history = await loadHistory(store);
      if (oddsData.available) {
        const last = history[history.length - 1];
        if (!last || finishedCount > last.g) {
          const fresh = await fetchMatchOdds(process.env.THE_ODDS_API_KEY, true);
          if (fresh.available) {
            oddsData = buildAdvance(groups, fresh, remaining);
            history.push({ t: new Date().toISOString(), g: finishedCount, p: roundProbs(oddsData.teamProb) });
            if (history.length > 200) history = history.slice(-200);
            await saveHistory(store, history);
          }
        }
      }
    }

    const payload = {
      updated: new Date().toISOString(),
      competition: standings.competition?.name || "FIFA World Cup",
      season: standings.season || null,
      groups, matches: trimmedMatches, odds: oddsData, finished: finishedCount,
    };
    if (history) payload.history = history;

    cache = { at: now, data: payload };
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: "server_error", message: "Something went wrong.", detail: String(err).slice(0, 300) });
  }
}
