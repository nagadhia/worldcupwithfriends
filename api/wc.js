// Serverless function (runs on Vercel) that talks to football-data.org for you.
// Your API key lives here on the server, never in the webpage — so it stays secret.
//
// It fetches the World Cup (competition code "WC") group standings and all matches,
// caches the result for 60s (the free tier allows 10 requests/minute), and returns
// a single tidy JSON blob to the page.

const COMP = "WC"; // football-data.org code for the FIFA World Cup
const BASE = "https://api.football-data.org/v4";

let cache = { at: 0, data: null };
const TTL_MS = 60 * 1000;

// ---- Optional: bookmaker "to win the World Cup" odds (The Odds API) ----
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const ODDS_TTL_MS = 3 * 60 * 60 * 1000; // 3h — outright odds move slowly; keeps us well under the free quota
let oddsCache = { at: 0, data: null };

async function getOdds(key, force) {
  if (!key) return { available: false, reason: "no_key" };
  const now = Date.now();
  if (!force && oddsCache.data && now - oddsCache.at < ODDS_TTL_MS) return oddsCache.data;
  try {
    const url = ODDS_BASE + "/sports/soccer_fifa_world_cup_winner/odds" +
      "?regions=uk&oddsFormat=decimal&apiKey=" + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      return { available: false,
        reason: r.status === 401 ? "bad_key" : r.status === 422 ? "market_unavailable" : "error",
        status: r.status, detail: t.slice(0, 200) };
    }
    const arr = await r.json();
    // Average each team's implied probability (1/decimal) across books, then normalise to remove the overround.
    const sums = {}, counts = {};
    for (const ev of (Array.isArray(arr) ? arr : [])) {
      for (const bk of (ev.bookmakers || [])) {
        for (const mk of (bk.markets || [])) {
          if (mk.key !== "outrights") continue;
          for (const oc of (mk.outcomes || [])) {
            if (!oc.price || oc.price <= 1) continue;
            sums[oc.name] = (sums[oc.name] || 0) + 1 / oc.price;
            counts[oc.name] = (counts[oc.name] || 0) + 1;
          }
        }
      }
    }
    const names = Object.keys(sums);
    if (!names.length) return { available: false, reason: "no_outcomes" };
    let total = 0; const avg = {};
    for (const n of names) { avg[n] = sums[n] / counts[n]; total += avg[n]; }
    const teamProb = {};
    for (const n of names) teamProb[n] = avg[n] / total;
    const data = { available: true, updated: new Date().toISOString(), teamProb, teams: names.length, source: "the-odds-api.com" };
    oddsCache = { at: now, data };
    return data;
  } catch (e) {
    return { available: false, reason: "exception", detail: String(e).slice(0, 200) };
  }
}

// ---- Optional: persistent odds history (Vercel KV / Upstash Redis, via REST) ----
function getStore() {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ""), token } : null;
}
const HISTORY_KEY = "odds-history";
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
  } catch (e) { /* ignore write errors */ }
}
function roundProbs(o) { const r = {}; for (const k in o) r[k] = Math.round(o[k] * 1e4) / 1e4; return r; }

export default async function handler(req, res) {
  const token = process.env.FOOTBALL_DATA_TOKEN;

  if (!token) {
    res.status(500).json({
      error: "missing_token",
      message:
        "No API key found. Add an environment variable named FOOTBALL_DATA_TOKEN in your Vercel project settings, then redeploy.",
    });
    return;
  }

  // Serve from cache when fresh, to stay well under the rate limit.
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
      const body = !standingsRes.ok
        ? await standingsRes.text()
        : await matchesRes.text();
      res.status(502).json({
        error: "upstream_error",
        status,
        message:
          status === 403
            ? "The API rejected the key. Double-check FOOTBALL_DATA_TOKEN is correct and active."
            : status === 429
            ? "Hit the free-tier rate limit (10/min). Give it a minute and refresh."
            : "The football data service returned an error.",
        detail: body.slice(0, 300),
      });
      return;
    }

    const standings = await standingsRes.json();
    const matches = await matchesRes.json();

    // Trim the standings to just what the page needs.
    const groups = (standings.standings || [])
      .filter((s) => s.type === "TOTAL" && s.group)
      .map((s) => ({
        group: s.group, // e.g. "GROUP_A"
        table: (s.table || []).map((row) => ({
          position: row.position,
          name: row.team?.name || "",
          shortName: row.team?.shortName || row.team?.tla || row.team?.name || "",
          crest: row.team?.crest || "",
          played: row.playedGames,
          won: row.won,
          draw: row.draw,
          lost: row.lost,
          gf: row.goalsFor,
          ga: row.goalsAgainst,
          gd: row.goalDifference,
          points: row.points,
        })),
      }));

    // Trim matches to the essentials, sorted by kickoff.
    const trimmedMatches = (matches.matches || [])
      .map((m) => ({
        id: m.id,
        utcDate: m.utcDate,
        status: m.status, // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
        stage: m.stage,
        group: m.group || null,
        home: m.homeTeam?.name || "TBD",
        homeCrest: m.homeTeam?.crest || "",
        away: m.awayTeam?.name || "TBD",
        awayCrest: m.awayTeam?.crest || "",
        homeScore: m.score?.fullTime?.home,
        awayScore: m.score?.fullTime?.away,
        winner: m.score?.winner || null,
      }))
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    const finishedCount = trimmedMatches.filter((m) => m.status === "FINISHED").length;
    let oddsData = await getOdds(process.env.THE_ODDS_API_KEY);

    // Snapshot the odds whenever the finished-game count increases (one point per game).
    const store = getStore();
    let history;
    if (store) {
      history = await loadHistory(store);
      if (oddsData.available) {
        const last = history[history.length - 1];
        if (!last || finishedCount > last.g) {
          const fresh = await getOdds(process.env.THE_ODDS_API_KEY, true); // post-game odds
          if (fresh.available) {
            oddsData = fresh;
            history.push({ t: new Date().toISOString(), g: finishedCount, p: roundProbs(fresh.teamProb) });
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
      groups,
      matches: trimmedMatches,
      odds: oddsData,
      finished: finishedCount,
    };
    if (history) payload.history = history;

    cache = { at: now, data: payload };

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({
      error: "server_error",
      message: "Something went wrong fetching the data.",
      detail: String(err).slice(0, 300),
    });
  }
}
