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

    const payload = {
      updated: new Date().toISOString(),
      competition: standings.competition?.name || "FIFA World Cup",
      season: standings.season || null,
      groups,
      matches: trimmedMatches,
    };

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
