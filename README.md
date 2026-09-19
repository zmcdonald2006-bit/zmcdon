# College Football Live Tracker

A live-updating college football site: scores, the full season schedule, the playoff bracket, team pages and game highlights. Pure static HTML/CSS/JS — no backend, no build step, no paid hosting required.

## Tabs

- **Scores** — every FBS game this week, split into Live / Upcoming / Final, with a filter bar (search by team, ranked-only, favorites, or by conference).
- **Calendar** — the full season schedule, week by week, grouped by day. Covers every regular-season week plus the entire postseason (all bowls and all 11 playoff games), with kickoff times in your local timezone, TV networks, and bowl names. Today's date is highlighted; games whose kickoff time hasn't been announced show "Time TBD" rather than a bogus midnight.
- **Previous Games** — completed games by week, newest first, with a week picker covering the whole season so far.
- **Teams** — search any of 762 teams for a team page with three views: **Schedule** (any season back to 2004, with a W-L record, results, opponent ranks, and bowl/playoff games merged in), **Roster** (grouped by offense/defense/special teams with number, position, height, weight, class, and hometown), and **News** (recent ESPN articles and videos). Your last team is remembered for next visit.
- **Playoff Bracket** — the 12-team College Football Playoff, drawn from real game results. Slots start as TBD and fill in as the field is set and games are played, so you can trace exactly who beat whom on the way to the title. A season picker shows past brackets (2024-25 onward).
- **Rankings** — any poll ESPN is publishing (AP, Coaches, and the CFP committee rankings once they start in late October) with records, points, and week-over-week movement. Your poll choice is remembered.

## Favorites

Star a team from its team page or from any game popup. Favorited teams get a marker and an accent stripe on their games, float to the top of each section, and can be isolated with the **Favorites** filter. Stored in your browser only.

## Sharing and links

Every tab has its own URL — `#scores`, `#bracket`, `#teams/61` — so you can bookmark or share a specific view, and the browser's back button moves between tabs.

## Highlights

Click or tap any game that has started — in **Calendar**, **Previous Games**, a team's **Schedule**, or the Final/Live sections of **Scores** — to open its detail popup:

- Every video highlight ESPN posted for that game, playing inline in the popup (clips without a direct video source open on ESPN instead).
- A full scoring summary: each scoring play with quarter, clock, team, and the running score.

Close it with the × button, by clicking outside it, or with Escape.

## How it works

- Pulls live data straight from ESPN's public scoreboard/rankings JSON endpoints, directly from your browser.
- Auto-refreshes every 30 seconds while any game is in progress, and every 5 minutes otherwise. Polling stops entirely while the tab is in the background and catches up when you return.
- Each section loads independently, so a rankings outage can't blank the scoreboard. If the scoreboard itself can't be reached the last good data stays on screen, labelled `Offline — showing <time>`, and retries back off instead of hammering.
- Grids only rebuild when something they show actually changed, so a live refresh doesn't throw away your hover, focus or scroll position every 30 seconds.
- The bracket is entirely data-driven: each slot knows which seeds belong in it, and semifinals are matched by which quarterfinal winners actually show up in them, so the bracket reflects the real path rather than an assumed one.
- Built for phones as well as desktops: single-column cards, scrollable tabs, a full-screen highlights sheet on small screens, and a horizontally scrollable bracket.
- Keyboard and screen-reader friendly: proper tablist semantics with arrow-key navigation, a focus-trapped modal that restores focus on close, a skip link, visible focus rings, and reduced-motion support.

## Built to last

Nothing about the current season is hardcoded:

- The season year, the current week, and the full week list all come from the API's own calendar, so a new season needs no code change. The system clock is only a fallback for the moment before the first response arrives.
- Season pickers rebuild themselves if the season rolls over while the page is open.
- The rankings poll list is whatever the API is publishing that week.
- If the playoff field ever grows past 12 teams, the bracket says so plainly and points you at the Calendar rather than silently drawing the wrong shape.

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
- `teams.json` is the one piece of bundled data: `{id, name, conf}` for 762 teams. ESPN's bulk team-list endpoint is the only one that sends no CORS headers, so it can't be called from the browser and the list ships with the site instead. It drives both the team search and the conference filter, and only needs regenerating when teams move conferences or join/leave Division I:

```bash
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=500&page=1" -o page1.json
curl -s "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=500&page=2" -o page2.json
curl -s "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/80/children?limit=50"
```

Keep `id` and `displayName` from the first two, then for each conference id the third returns, read its `shortName` and its `/teams` list to map team → conference.
- Conference filtering uses each team's own conference, not `competition.groups` — ESPN only sets that on conference matchups, so filtering on it would have hidden every non-conference game.
- Currently shows FBS games only (`groups=80`).
- The bracket assumes the 12-team CFP format (seeds 1-4 on a bye; 5/12, 6/11, 7/10, 8/9 in the first round), which is the format for the 2026 season. If the playoff expands, the slot definitions at the top of the bracket section in `app.js` are where to change it.
