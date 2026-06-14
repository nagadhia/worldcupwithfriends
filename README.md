# Chris vs Nandini — World Cup 2026 tracker

A live head-to-head tracker for your group-stage sweepstakes. It shows Chris's and
Nandini's combined league points as a scoreboard, every group table with their picked
teams highlighted, and who's qualifying. It refreshes itself every minute.

It's two files:
- `index.html` — the page everyone looks at.
- `api/wc.js` — a tiny function that fetches live data and keeps your API key secret.

Total setup: about 10 minutes, no cost, nothing to maintain.

---

## What you need to do

### 1. Get a free data key (2 min)
1. Go to **https://www.football-data.org/client/register** and sign up (just an email).
2. They email you an **API token** — a long string of letters and numbers. Keep it handy.
   - The free tier covers the World Cup, including standings and results. That's all this needs.

### 2. Put the project on GitHub (3 min)
*(Vercel deploys from a GitHub repo. If you'd rather drag-and-drop, skip to the note at the bottom.)*
1. Create a free account at **https://github.com** if you don't have one.
2. Make a new repository (the **＋** top-right → *New repository*). Name it anything, e.g. `wc-tracker`. Keep it public or private — either works.
3. Upload these files so the structure looks exactly like this:
   ```
   wc-tracker/
   ├─ index.html
   └─ api/
      └─ wc.js
   ```
   (Use *Add file → Upload files*. Make sure `wc.js` ends up inside an `api` folder — that folder name matters.)

### 3. Deploy on Vercel (3 min)
1. Sign up at **https://vercel.com** with your GitHub account (free "Hobby" plan).
2. Click **Add New… → Project**, pick your `wc-tracker` repo, and **Import**.
3. Don't change any build settings — leave everything default and click **Deploy**.
4. Wait for it to finish. You'll get a live URL like `https://wc-tracker-xxxx.vercel.app`.

### 4. Add your key (1 min) — important
The page will show a "Setup needed" banner until you do this.
1. In your Vercel project: **Settings → Environment Variables**.
2. Add one variable:
   - **Name:** `FOOTBALL_DATA_TOKEN`
   - **Value:** the token from step 1
3. Save, then go to **Deployments → ⋯ on the latest one → Redeploy** so it picks up the key.

### 5. The picks are already in
Both lists are baked into `index.html` — Nandini's 24 teams and Chris's 24 — so the shared link is ready the moment it's deployed. Names are matched loosely, so accents and spellings (Türkiye, Korea Republic, Côte d'Ivoire, IR Iran, DR Congo) all resolve correctly.

To change a pick later: click **Edit picks** on the site (saves in your browser only), or edit the `DEFAULT_PICKS` block near the top of `index.html`'s `<script>` and commit — Vercel redeploys automatically so everyone sees it.

That's it — deploy, add the key, and share the Vercel link with Chris.

---

### Optional: "Who's favoured" title-odds predictor
The site can show a prediction bar — each player's combined chance of owning the eventual World Cup winner, from bookmakers' outright odds. It's **optional**: if you skip this, the panel simply doesn't appear and everything else works.

To switch it on:
1. Sign up free at **https://the-odds-api.com** — you get an API key and a monthly request quota.
2. In Vercel → **Settings → Environment Variables**, add a second variable:
   - **Name:** `THE_ODDS_API_KEY`
   - **Value:** the key from step 1
3. Redeploy.

The function only checks the odds once every 3 hours (outright prices barely move), so it stays well within the free quota.

**Heads-up:** free odds tiers change often, and the specific "tournament winner" market isn't guaranteed to be free forever. To check whether yours is working, open `https://your-site.vercel.app/api/wc` and look at the `odds` field — `"available": true` means it's live; anything else (e.g. `"market_unavailable"` or `"bad_key"`) tells you why the panel is hidden. The rest of the tracker is unaffected regardless.

Note this metric predicts who lifts the trophy — which favours the big nations — and is a different lens from your scoreboard, which rewards group-stage points and doubles each captain.

### Good to know
- **Captains score double.** Brazil (Nandini) and Argentina (Chris) count their league points twice on the scoreboard. To change captains later, edit the `CAPTAINS` list near the top of `index.html`'s `<script>`.
- **Free limits:** the data feed allows 10 requests/minute. The function caches for 60s, so a normal office crowd is nowhere near it. If you ever see a rate-limit note, wait a minute.
- **It updates itself** every 60 seconds while the page is open; there's also a Refresh button.
- **Don't want GitHub?** Install the Vercel CLI (`npm i -g vercel`), run `vercel` inside the project folder, and follow the prompts. Then add the environment variable with `vercel env add FOOTBALL_DATA_TOKEN`.
- The data covers the group stage tables. Knockout rounds don't have "groups", so once the bracket starts I can add a knockout view — just ask.
