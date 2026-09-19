# College Football Live Tracker

A live-updating scoreboard + AP Top 25 rankings table, styled like an ESPN/March-Madness bracket page. Pure static HTML/CSS/JS — no backend, no build step, no paid hosting required.

## Tabs

- **Scores** — every FBS game this week, split into Live / Upcoming / Final.
- **Calendar** — the full season schedule, week by week, grouped by day. Covers every regular-season week plus the entire postseason (all bowls and all 11 playoff games), with kickoff times in your local timezone, TV networks, and bowl names. Today's date is highlighted; games whose kickoff time hasn't been announced show "Time TBD" rather than a bogus midnight.
- **Previous Games** — completed games by week, newest first, with a week picker covering the whole season so far.
- **Teams** — search any of 762 teams for a team page with three views: **Schedule** (any season back to 2004, with a W-L record, results, opponent ranks, and bowl/playoff games merged in), **Roster** (grouped by offense/defense/special teams with number, position, height, weight, class, and hometown), and **News** (recent ESPN articles and videos). Your last team is remembered for next visit.
- **Playoff Bracket** — the 12-team College Football Playoff, drawn from real game results. Slots start as TBD and fill in as the field is set and games are played, so you can trace exactly who beat whom on the way to the title. A season picker shows past brackets (2024-25 onward).
- **AP Top 25** — current poll with records, points, and week-over-week movement.

## Highlights

Click or tap any game that has started — in **Calendar**, **Previous Games**, a team's **Schedule**, or the Final/Live sections of **Scores** — to open its detail popup:

- Every video highlight ESPN posted for that game, playing inline in the popup (clips without a direct video source open on ESPN instead).
- A full scoring summary: each scoring play with quarter, clock, team, and the running score.

Close it with the × button, by clicking outside it, or with Escape.

## How it works

- Pulls live data straight from ESPN's public scoreboard/rankings JSON endpoints, directly from your browser.
- Auto-refreshes every 30 seconds while any game is in progress, and every 5 minutes otherwise (so it doesn't hammer the API when nothing's happening).
- Also refreshes whenever you switch back to the browser tab.
- The bracket is entirely data-driven: each slot knows which seeds belong in it, and semifinals are matched by which quarterfinal winners actually show up in them, so the bracket reflects the real path rather than an assumed one.
- Built for phones as well as desktops: single-column cards, scrollable tabs, a full-screen highlights sheet on small screens, and a horizontally scrollable bracket.

## Run it locally

Any static file server works. Easiest with Python (if installed):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/`. (Opening `index.html` directly via `file://` won't work — the browser blocks the API fetch from a file URL in some cases, so use a local server.)

Don't have Python/Node installed? This repo includes `serve.ps1`, a zero-dependency PowerShell static server:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open `http://localhost:8080/`. It's only for local testing — not part of the deployed site.

## Deploy for free

**GitHub Pages (recommended):**

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/cfb-tracker.git
git push -u origin main
```

Then in the repo on GitHub: Settings → Pages → Source: `main` branch, `/ (root)` folder. Your site will be live at `https://<your-username>.github.io/cfb-tracker/` within a minute or two.

**Alternatives (also free, drag-and-drop, no git needed):**
- [Netlify Drop](https://app.netlify.com/drop) — drag the folder in, get a URL instantly.
- [Vercel](https://vercel.com) — `vercel deploy` or connect the GitHub repo.

## Notes / limitations

- The ESPN endpoints used here are public but unofficial (no API key, no docs, no SLA). If ESPN changes the response shape or blocks a request pattern, the page may need a small update — the fetch URLs and field names are all in `app.js`.
- `teams.json` is the one piece of bundled data. ESPN's bulk team-list endpoint is the only one that sends no CORS headers, so it can't be called from the browser; the list ships with the site instead. It only needs regenerating when teams join or leave Division I — pull both pages and keep `id` and `displayName` from each entry:

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=500&page=1" -o page1.json
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=500&page=2" -o page2.json
```
- Currently shows FBS games only (`groups=80`). Ranking data is the AP Top 25 poll.
- The bracket assumes the 12-team CFP format (seeds 1-4 on a bye; 5/12, 6/11, 7/10, 8/9 in the first round), which is the format for the 2026 season. If the playoff expands, the slot definitions at the top of the bracket section in `app.js` are where to change it.
