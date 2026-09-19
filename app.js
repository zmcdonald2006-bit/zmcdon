const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=200";
const RANKINGS_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings";

const LIVE_POLL_MS = 30 * 1000;
const IDLE_POLL_MS = 5 * 60 * 1000;

let pollTimer = null;

function setLastUpdated() {
  const el = document.getElementById("lastUpdated");
  el.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rankBadge(competitor) {
  const rank = competitor.curatedRank && competitor.curatedRank.current;
  if (rank && rank <= 25) return `#${rank}`;
  return "";
}

function teamRow(competitor, isWinner) {
  const team = competitor.team;
  const rank = rankBadge(competitor);
  const score = competitor.score ?? "";
  return `
    <div class="team-row${isWinner ? " winner" : ""}">
      <div class="team-name">
        <span class="rank">${rank}</span>
        <img class="logo" src="${team.logo || ""}" alt="" onerror="this.style.visibility='hidden'">
        <span>${team.shortDisplayName || team.displayName}</span>
      </div>
      <div class="score">${score}</div>
    </div>`;
}

function gameCard(event, showDate) {
  const comp = event.competitions[0];
  const status = comp.status;
  const state = status.type.state; // pre | in | post
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");

  let homeWin = false, awayWin = false;
  if (state === "post") {
    homeWin = Number(home.score) > Number(away.score);
    awayWin = Number(away.score) > Number(home.score);
  }

  let metaRight = "";
  if (state === "pre") {
    metaRight = comp.timeValid === false
      ? new Date(event.date).toLocaleDateString([], { weekday: "short" }) + " · TBD"
      : new Date(event.date).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  } else if (state === "in") {
    metaRight = `<span class="live-dot">● LIVE</span> ${status.type.shortDetail}`;
  } else {
    metaRight = status.type.shortDetail || "Final";
  }

  const broadcast = comp.broadcast ? `<div class="broadcast">${comp.broadcast}</div>` : "";

  let metaLeft = comp.groups ? comp.groups.shortName : "";
  if (showDate) {
    metaLeft = new Date(event.date).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Only games that have started have highlights or a scoring summary worth opening.
  const openable = state !== "pre";

  return `
    <div class="game-card${openable ? " clickable" : ""}" data-state="${state}"${openable ? ` data-event-id="${event.id}" tabindex="0" role="button"` : ""}>
      <div class="meta">
        <span>${metaLeft}</span>
        <span>${metaRight}</span>
      </div>
      ${teamRow(away, awayWin)}
      ${teamRow(home, homeWin)}
      ${broadcast}
    </div>`;
}

function renderGrid(elId, events, emptyMsg, showDate) {
  const el = document.getElementById(elId);
  if (!events.length) {
    el.className = "game-grid empty";
    el.innerHTML = emptyMsg;
    return;
  }
  el.className = "game-grid";
  el.innerHTML = events.map(ev => gameCard(ev, showDate)).join("");
}

async function loadScores() {
  const res = await fetch(SCOREBOARD_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("scoreboard fetch failed: " + res.status);
  const data = await res.json();
  captureCalendar(data);
  const events = data.events || [];

  const live = [], upcoming = [], final = [];
  for (const ev of events) {
    const state = ev.competitions[0].status.type.state;
    if (state === "in") live.push(ev);
    else if (state === "pre") upcoming.push(ev);
    else final.push(ev);
  }
  upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
  final.sort((a, b) => new Date(b.date) - new Date(a.date));

  renderGrid("liveGames", live, "No games in progress.");
  renderGrid("upcomingGames", upcoming, "No upcoming games this week.");
  renderGrid("finalGames", final, "No completed games yet.");

  return live.length > 0;
}

function trendClass(trend) {
  if (!trend || trend === "-") return "trend-flat";
  if (trend.startsWith("+")) return "trend-up";
  if (trend.startsWith("-")) return "trend-down";
  return "trend-flat";
}

async function loadRankings() {
  const res = await fetch(RANKINGS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("rankings fetch failed: " + res.status);
  const data = await res.json();
  const poll = (data.rankings || []).find(p => p.name === "AP Top 25") || data.rankings[0];
  const body = document.getElementById("rankingsBody");

  if (!poll || !poll.ranks || !poll.ranks.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-row">Rankings not available right now.</td></tr>`;
    return;
  }

  body.innerHTML = poll.ranks.map(r => `
    <tr>
      <td>${r.current}</td>
      <td><img class="logo" src="${r.team.logo || ""}" alt="" onerror="this.style.visibility='hidden'"></td>
      <td>${r.team.location} ${r.team.name || r.team.nickname}</td>
      <td>${r.recordSummary || ""}</td>
      <td>${r.points ?? ""}</td>
      <td class="${trendClass(r.trend)}">${r.trend || ""}</td>
    </tr>`).join("");
}

async function refreshAll() {
  try {
    const [hasLive] = await Promise.all([
      loadScores(),
      loadRankings(),
      refreshBracketIfVisible(),
      refreshPreviousIfVisible(),
      refreshCalendarIfVisible()
    ]);
    setLastUpdated();
    schedulePoll(hasLive);
  } catch (err) {
    document.getElementById("lastUpdated").textContent = "Update failed — retrying…";
    schedulePoll(false);
    console.error(err);
  }
}

function schedulePoll(hasLive) {
  if (pollTimer) clearTimeout(pollTimer);
  const interval = hasLive ? LIVE_POLL_MS : IDLE_POLL_MS;
  pollTimer = setTimeout(refreshAll, interval);
}

/* ---------- Previous games ---------- */

const SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=";

let seasonMeta = null;
const weekCache = new Map();
const summaryCache = new Map();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The scoreboard response carries the season calendar, so the week list comes
// from the API rather than being hardcoded.
function captureCalendar(data) {
  if (seasonMeta) return;
  const league = (data.leagues || [])[0];
  if (!league || !league.calendar) return;

  const now = new Date();
  const weeks = [];
  for (const section of league.calendar) {
    const seasontype = Number(section.value);
    if (seasontype !== 2 && seasontype !== 3) continue;
    for (const entry of section.entries || []) {
      weeks.push({
        label: entry.label,
        value: Number(entry.value),
        seasontype,
        started: new Date(entry.startDate) <= now
      });
    }
  }
  if (!weeks.length) return;

  seasonMeta = {
    year: data.season ? data.season.year : currentSeasonYear(),
    currentWeek: data.week ? data.week.number : weeks[0].value,
    currentType: data.season ? data.season.type : 2,
    weeks
  };
  seasonMeta.currentKey = `${seasonMeta.currentType}:${seasonMeta.currentWeek}`;

  initWeekSelect();
  initCalendarSelect();
  loadCalendar().catch(console.error);
}

function fillWeekSelect(select, weeks) {
  select.innerHTML = "";
  for (const w of weeks) {
    const opt = document.createElement("option");
    opt.value = `${w.seasontype}:${w.value}`;
    opt.textContent = w.seasontype === 3 ? `Postseason — ${w.label}` : w.label;
    select.appendChild(opt);
  }
  if ([...select.options].some(o => o.value === seasonMeta.currentKey)) {
    select.value = seasonMeta.currentKey;
  }
}

async function fetchWeekEvents(key, force) {
  const cached = weekCache.get(key);
  if (cached && !force) return cached;

  const [seasontype, week] = key.split(":").map(Number);
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&seasontype=${seasontype}&week=${week}&dates=${seasonMeta.year}&limit=400`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("week fetch failed: " + res.status);
  const data = await res.json();
  const events = data.events || [];
  weekCache.set(key, events);
  return events;
}

function initWeekSelect() {
  const select = document.getElementById("weekSelect");
  fillWeekSelect(select, seasonMeta.weeks.filter(w => w.started).reverse());
  select.addEventListener("change", () => loadPreviousGames().catch(console.error));
}

async function loadPreviousGames(force) {
  if (!seasonMeta) return;
  const select = document.getElementById("weekSelect");
  const key = select.value;
  if (!key) return;

  const events = await fetchWeekEvents(key, force || key === seasonMeta.currentKey);

  // A different week may have been picked while this request was in flight.
  if (select.value !== key) return;

  const finished = events
    .filter(ev => ev.competitions[0].status.type.completed)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  renderGrid("previousGames", finished, "No completed games for this week yet.", true);
}

/* ---------- Calendar ---------- */

function initCalendarSelect() {
  const select = document.getElementById("calendarSelect");
  fillWeekSelect(select, seasonMeta.weeks);
  select.addEventListener("change", () => loadCalendar().catch(console.error));
}

function calendarLabel(ev) {
  const h = headlineOf(ev);
  if (/National Championship/i.test(h)) return "CFP National Championship";
  if (/Semifinal/i.test(h)) return `CFP Semifinal &middot; ${bowlName(ev)}`;
  if (/Quarterfinal/i.test(h)) return `CFP Quarterfinal &middot; ${bowlName(ev)}`;
  if (/First Round/i.test(h)) return "CFP First Round";
  if (h) return h;
  const groups = ev.competitions[0].groups;
  return groups ? groups.shortName : "";
}

function calendarTeam(competitor, opponent, showScore, decided) {
  const team = competitor.team;
  const rank = competitor.curatedRank && competitor.curatedRank.current;
  const won = decided && Number(competitor.score) > Number(opponent.score);
  return `
    <div class="cal-team${won ? " winner" : ""}">
      <span class="cal-rank">${rank && rank <= 25 ? "#" + rank : ""}</span>
      <img src="${esc(team.logo || "")}" alt="" onerror="this.style.visibility='hidden'">
      <span class="cal-name">${esc(team.shortDisplayName || team.displayName)}</span>
      <span class="cal-score">${showScore ? esc(competitor.score ?? "") : ""}</span>
    </div>`;
}

function calendarRow(ev) {
  const comp = ev.competitions[0];
  const status = comp.status;
  const state = status.type.state;
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  const started = state !== "pre";

  let when;
  if (state === "in") when = `<span class="live-dot">●</span> ${esc(status.type.shortDetail)}`;
  else if (state === "post") when = "Final";
  // ESPN parks kickoff at midnight until the time is announced.
  else if (comp.timeValid === false) when = "Time TBD";
  else when = new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const label = calendarLabel(ev);
  const broadcast = comp.broadcast ? `<span class="cal-tv">${esc(comp.broadcast)}</span>` : "";

  return `
    <li class="cal-row${started ? " clickable" : ""}"${started ? ` data-event-id="${esc(ev.id)}" tabindex="0" role="button"` : ""}>
      <div class="cal-when${state === "in" ? " live" : ""}">${when}</div>
      <div class="cal-matchup">
        ${calendarTeam(away, home, started, state === "post")}
        ${calendarTeam(home, away, started, state === "post")}
      </div>
      <div class="cal-info">
        <span class="cal-label">${label}</span>
        ${broadcast}
      </div>
    </li>`;
}

function renderCalendar(events) {
  const view = document.getElementById("calendarView");
  if (!events.length) {
    view.innerHTML = `<p class="modal-empty">No games scheduled for this week.</p>`;
    return;
  }

  const byDay = new Map();
  for (const ev of events.slice().sort((a, b) => new Date(a.date) - new Date(b.date))) {
    const day = new Date(ev.date).toDateString();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }

  const today = new Date().toDateString();
  view.innerHTML = [...byDay.entries()].map(([day, dayEvents]) => {
    const label = new Date(day).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    return `
      <section class="cal-day">
        <h3 class="cal-date${day === today ? " is-today" : ""}">
          <span>${label}${day === today ? " &middot; Today" : ""}</span>
          <span class="cal-count">${dayEvents.length} game${dayEvents.length === 1 ? "" : "s"}</span>
        </h3>
        <ul class="cal-list">${dayEvents.map(calendarRow).join("")}</ul>
      </section>`;
  }).join("");
}

async function loadCalendar(force) {
  if (!seasonMeta) return;
  const select = document.getElementById("calendarSelect");
  const key = select.value;
  if (!key) return;

  const events = await fetchWeekEvents(key, force || key === seasonMeta.currentKey);
  if (select.value !== key) return;
  renderCalendar(events);
}

function refreshCalendarIfVisible() {
  if (activeTabName() !== "calendar") return Promise.resolve();
  return loadCalendar(true).catch(err => console.error(err));
}

function refreshPreviousIfVisible() {
  if (activeTabName() !== "previous") return Promise.resolve();
  return loadPreviousGames(true).catch(err => console.error(err));
}

/* ---------- Game highlights ---------- */

function formatDuration(seconds) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function clipHtml(video) {
  const mp4 = video.links && video.links.source && video.links.source.href;
  const web = (video.links && video.links.web && video.links.web.href) ||
    `https://www.espn.com/video/clip?id=${video.id}`;
  const duration = formatDuration(video.duration);
  return `
    <div class="clip" tabindex="0" role="button"${mp4 ? ` data-mp4="${esc(mp4)}"` : ""} data-web="${esc(web)}">
      <div class="clip-thumb">
        <img src="${esc(video.thumbnail || "")}" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="clip-play">▶</span>
        ${duration ? `<span class="clip-dur">${duration}</span>` : ""}
      </div>
      <div class="clip-title">${esc(video.headline || "Highlight")}</div>
    </div>`;
}

function scoringPlayHtml(play, awayAbbr, homeAbbr) {
  const logo = play.team && play.team.logo;
  const period = play.period ? play.period.number : "";
  const clock = play.clock ? play.clock.displayValue : "";
  return `
    <li class="play">
      <span class="play-clock">Q${period} ${esc(clock)}</span>
      ${logo ? `<img class="play-logo" src="${esc(logo)}" alt="">` : ""}
      <span class="play-text">${esc((play.text || "").trim())}</span>
      <span class="play-score">${esc(awayAbbr)} ${play.awayScore} &ndash; ${esc(homeAbbr)} ${play.homeScore}</span>
    </li>`;
}

function summaryHtml(summary) {
  const comp = summary.header.competitions[0];
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  const logoOf = c => (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || c.team.logo || "";
  const teamLine = c => `
    <div class="modal-team${c.winner ? " winner" : ""}">
      <img src="${esc(logoOf(c))}" alt="" onerror="this.style.visibility='hidden'">
      <span class="modal-team-name">${esc(c.team.displayName)}</span>
      <span class="modal-team-score">${esc(c.score)}</span>
    </div>`;

  const venue = summary.gameInfo && summary.gameInfo.venue;
  let venueLine = "";
  if (venue) {
    venueLine = esc(venue.fullName);
    const city = venue.address && venue.address.city;
    // Stadium names often already carry the city, e.g. "Alumni Stadium (Chestnut Hill, MA)".
    if (city && !venue.fullName.includes(city)) {
      venueLine += ` &middot; ${esc(city)}${venue.address.state ? ", " + esc(venue.address.state) : ""}`;
    }
  }

  const videos = summary.videos || [];
  const plays = summary.scoringPlays || [];

  const highlights = videos.length
    ? `<div class="clip-grid">${videos.map(clipHtml).join("")}</div>`
    : `<p class="modal-empty">No video highlights posted for this game.</p>`;

  const scoring = plays.length
    ? `<ul class="play-list">${plays.map(p => scoringPlayHtml(p, away.team.abbreviation, home.team.abbreviation)).join("")}</ul>`
    : `<p class="modal-empty">No scoring plays recorded.</p>`;

  return `
    <div class="modal-header">
      <h2 id="modalTitle" class="modal-score">
        ${teamLine(away)}
        ${teamLine(home)}
      </h2>
      <div class="modal-sub">
        ${esc(comp.status.type.shortDetail)}
        ${venueLine ? ` &middot; ${venueLine}` : ""}
      </div>
    </div>
    <h3 class="modal-section">Highlights${videos.length ? ` <span class="count">${videos.length}</span>` : ""}</h3>
    ${highlights}
    <h3 class="modal-section">Scoring Summary</h3>
    ${scoring}`;
}

function openModal() {
  document.getElementById("gameModal").hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("modalClose").focus();
}

function closeModal() {
  document.getElementById("gameModal").hidden = true;
  document.body.classList.remove("modal-open");
  document.getElementById("modalBody").innerHTML = "";
}

async function showGameDetails(eventId) {
  const body = document.getElementById("modalBody");
  openModal();
  body.innerHTML = `<div class="modal-loading">Loading highlights…</div>`;

  try {
    let summary = summaryCache.get(eventId);
    if (!summary) {
      const res = await fetch(SUMMARY_URL + encodeURIComponent(eventId), { cache: "no-store" });
      if (!res.ok) throw new Error("summary fetch failed: " + res.status);
      summary = await res.json();
      summaryCache.set(eventId, summary);
    }
    if (document.getElementById("gameModal").hidden) return;
    body.innerHTML = summaryHtml(summary);
  } catch (err) {
    body.innerHTML = `<div class="modal-loading">Couldn't load this game. Try again in a moment.</div>`;
    console.error(err);
  }
}

function initModal() {
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("gameModal").addEventListener("click", e => {
    if (e.target.id === "gameModal") closeModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("gameModal").hidden) closeModal();
  });

  document.getElementById("modalBody").addEventListener("click", e => {
    const clip = e.target.closest(".clip");
    if (!clip || clip.querySelector("video")) return;
    if (!clip.dataset.mp4) {
      window.open(clip.dataset.web, "_blank", "noopener");
      return;
    }
    const video = document.createElement("video");
    video.src = clip.dataset.mp4;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    clip.querySelector(".clip-thumb").replaceChildren(video);
  });

  document.addEventListener("click", e => {
    const card = e.target.closest("[data-event-id]");
    if (card) showGameDetails(card.dataset.eventId);
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest("[data-event-id]");
    if (card) {
      e.preventDefault();
      showGameDetails(card.dataset.eventId);
    }
  });
}

/* ---------- Teams ---------- */

const TEAM_API = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams";
const OLDEST_SEASON = 2004;

let teamIndex = null;
let currentTeamId = null;
const teamDataCache = new Map();

function rememberTeam(id) {
  try { localStorage.setItem("cfb-team", id); } catch (e) { /* private mode */ }
}

function recallTeam() {
  try { return localStorage.getItem("cfb-team"); } catch (e) { return null; }
}

// ESPN's bulk /teams endpoint is the one call that sends no CORS headers, so the
// team list ships with the site instead. See README for how to regenerate it.
async function loadTeamIndex() {
  if (teamIndex) return teamIndex;

  const res = await fetch("teams.json");
  if (!res.ok) throw new Error("teams.json fetch failed: " + res.status);
  teamIndex = await res.json();

  document.getElementById("teamOptions").innerHTML =
    teamIndex.map(t => `<option value="${esc(t.name)}"></option>`).join("");
  return teamIndex;
}

function resolveTeam(text) {
  if (!teamIndex || !text) return null;
  const q = text.trim().toLowerCase();
  if (!q) return null;
  return teamIndex.find(t => t.name.toLowerCase() === q) ||
    teamIndex.find(t => t.name.toLowerCase().startsWith(q)) ||
    teamIndex.find(t => t.name.toLowerCase().includes(q)) ||
    null;
}

function initTeamSeasonSelect() {
  const select = document.getElementById("teamSeason");
  if (select.options.length) return;
  const current = currentSeasonYear();
  for (let y = current; y >= OLDEST_SEASON; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = `${y}-${String(y + 1).slice(2)}`;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    if (currentTeamId) loadTeamSchedule(currentTeamId, Number(select.value)).catch(console.error);
  });
}

async function teamJson(url, cacheKey) {
  if (cacheKey && teamDataCache.has(cacheKey)) return teamDataCache.get(cacheKey);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("team request failed: " + res.status);
  const data = await res.json();
  if (cacheKey) teamDataCache.set(cacheKey, data);
  return data;
}

function renderTeamHeader(team) {
  const record = (team.record && team.record.items && team.record.items[0] && team.record.items[0].summary) || "";
  const next = team.nextEvent && team.nextEvent[0];
  const logo = (team.logos && team.logos[0] && team.logos[0].href) || "";
  const bits = [record, team.standingSummary].filter(Boolean).map(esc).join(" &middot; ");

  let nextLine = "";
  if (next) {
    const when = new Date(next.date).toLocaleDateString([], { month: "short", day: "numeric" });
    nextLine = `<div class="team-next">Next: ${esc(next.shortName || next.name)} &middot; ${when}</div>`;
  }

  document.getElementById("teamHeader").innerHTML = `
    <div class="team-hero" style="border-left-color:#${esc(team.color || "555555")}">
      <img src="${esc(logo)}" alt="" onerror="this.style.display='none'">
      <div class="team-hero-info">
        <h2>${team.rank && team.rank <= 25 ? `<span class="team-rank">#${team.rank}</span> ` : ""}${esc(team.displayName)}</h2>
        ${bits ? `<div class="team-meta">${bits}</div>` : ""}
        ${nextLine}
      </div>
    </div>`;
}

function scheduleRow(ev, teamId) {
  const comp = ev.competitions[0];
  const self = comp.competitors.find(c => String(c.team.id) === String(teamId));
  const opp = comp.competitors.find(c => String(c.team.id) !== String(teamId));
  if (!self || !opp) return "";

  const completed = comp.status && comp.status.type && comp.status.type.completed;
  const scoreOf = c => (c.score && typeof c.score === "object" ? c.score.displayValue : c.score) ?? "";
  const oppRank = opp.curatedRank && opp.curatedRank.current;

  let result = "";
  if (completed) {
    const won = self.winner === true;
    result = `<span class="sched-result ${won ? "win" : "loss"}">${won ? "W" : "L"}</span>
      <span class="sched-score">${esc(scoreOf(self))}-${esc(scoreOf(opp))}</span>`;
  } else {
    const time = comp.timeValid === false
      ? "TBD"
      : new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    result = `<span class="sched-upcoming">${esc(time)}</span>`;
  }

  const prefix = comp.neutralSite ? "vs" : (self.homeAway === "home" ? "vs" : "at");

  return `
    <li class="sched-row${completed ? " clickable" : ""}"${completed ? ` data-event-id="${esc(ev.id)}" tabindex="0" role="button"` : ""}>
      <span class="sched-date">${new Date(ev.date).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
      <span class="sched-opp">
        <span class="sched-prefix">${prefix}</span>
        ${oppRank && oppRank <= 25 ? `<span class="sched-rank">#${oppRank}</span>` : ""}
        <img src="${esc((opp.team.logos && opp.team.logos[0] && opp.team.logos[0].href) || opp.team.logo || "")}" alt="" onerror="this.style.visibility='hidden'">
        <span class="sched-name">${esc(opp.team.displayName || opp.team.shortDisplayName)}</span>
      </span>
      <span class="sched-outcome">${result}</span>
      <span class="sched-week">${esc((ev.week && ev.week.text) || (ev.seasonType && ev.seasonType.name) || "")}</span>
    </li>`;
}

async function loadTeamSchedule(teamId, season) {
  const view = document.getElementById("teamScheduleView");
  view.innerHTML = `<p class="modal-empty">Loading schedule…</p>`;

  // The schedule endpoint returns regular season only; bowls and playoff games
  // need a second request with seasontype=3.
  const [regular, post] = await Promise.all([
    teamJson(`${TEAM_API}/${teamId}/schedule?season=${season}`, `sched:${teamId}:${season}:2`),
    teamJson(`${TEAM_API}/${teamId}/schedule?season=${season}&seasontype=3`, `sched:${teamId}:${season}:3`)
      .catch(() => ({ events: [] }))
  ]);
  if (currentTeamId !== teamId || Number(document.getElementById("teamSeason").value) !== season) return;

  const seen = new Set();
  const events = [...(regular.events || []), ...(post.events || [])]
    .filter(ev => !seen.has(ev.id) && seen.add(ev.id))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!events.length) {
    view.innerHTML = `<p class="modal-empty">No games found for the ${season} season.</p>`;
    return;
  }

  let wins = 0, losses = 0;
  for (const ev of events) {
    const self = ev.competitions[0].competitors.find(c => String(c.team.id) === String(teamId));
    if (!ev.competitions[0].status.type.completed || !self) continue;
    self.winner === true ? wins++ : losses++;
  }

  view.innerHTML = `
    ${wins + losses ? `<p class="sched-summary">${wins}-${losses} in ${season}</p>` : ""}
    <ul class="sched-list">${events.map(ev => scheduleRow(ev, teamId)).join("")}</ul>`;
}

async function loadTeamRoster(teamId) {
  const view = document.getElementById("teamRosterView");
  view.innerHTML = `<p class="modal-empty">Loading roster…</p>`;

  const data = await teamJson(`${TEAM_API}/${teamId}/roster`, `roster:${teamId}`);
  if (currentTeamId !== teamId) return;

  const labels = {
    offense: "Offense",
    defense: "Defense",
    specialTeam: "Special Teams",
    injuredReserveOrOut: "Out",
    suspended: "Suspended",
    practiceSquad: "Practice Squad"
  };

  const groups = (data.athletes || []).filter(g => (g.items || []).length);
  if (!groups.length) {
    view.innerHTML = `<p class="modal-empty">No roster posted for this team.</p>`;
    return;
  }

  view.innerHTML = groups.map(group => {
    const rows = group.items
      .slice()
      .sort((a, b) => (Number(a.jersey) || 999) - (Number(b.jersey) || 999))
      .map(p => {
        const home = p.birthPlace
          ? [p.birthPlace.city, p.birthPlace.state || p.birthPlace.country].filter(Boolean).join(", ")
          : "";
        return `
          <tr>
            <td class="r-num">${esc(p.jersey || "")}</td>
            <td class="r-name">${esc(p.fullName || p.displayName)}</td>
            <td>${esc((p.position && p.position.abbreviation) || "")}</td>
            <td class="r-hide">${esc(p.displayHeight || "")}</td>
            <td class="r-hide">${esc(p.displayWeight || "")}</td>
            <td>${esc((p.experience && p.experience.displayValue) || "")}</td>
            <td class="r-hide">${esc(home)}</td>
          </tr>`;
      }).join("");

    return `
      <h3 class="roster-group">${esc(labels[group.position] || group.position)}
        <span class="cal-count">${group.items.length}</span>
      </h3>
      <div class="table-scroll">
        <table class="roster-table">
          <thead>
            <tr>
              <th>#</th><th>Name</th><th>Pos</th>
              <th class="r-hide">Ht</th><th class="r-hide">Wt</th>
              <th>Class</th><th class="r-hide">Hometown</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join("");
}

async function loadTeamNews(teamId) {
  const view = document.getElementById("teamNewsView");
  view.innerHTML = `<p class="modal-empty">Loading news…</p>`;

  const data = await teamJson(
    `https://site.api.espn.com/apis/site/v2/sports/football/college-football/news?team=${teamId}&limit=20`,
    `news:${teamId}`
  );
  if (currentTeamId !== teamId) return;

  const articles = data.articles || [];
  if (!articles.length) {
    view.innerHTML = `<p class="modal-empty">No recent news for this team.</p>`;
    return;
  }

  view.innerHTML = `<div class="news-grid">${articles.map(a => {
    const link = (a.links && a.links.web && a.links.web.href) || "";
    const image = (a.images && a.images[0] && a.images[0].url) || "";
    const when = a.published
      ? new Date(a.published).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
      : "";
    const headline = a.headline || "";
    // Video clips repeat the headline as their description.
    const desc = (a.description || "").trim() === headline.trim() ? "" : a.description || "";
    return `
      <a class="news-card" href="${esc(link)}" target="_blank" rel="noopener">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
        <div class="news-body">
          <div class="news-headline">${esc(headline)}</div>
          ${desc ? `<div class="news-desc">${esc(desc)}</div>` : ""}
          <div class="news-date">${esc(when)}</div>
        </div>
      </a>`;
  }).join("")}</div>`;
}

function activeSubtab() {
  const btn = document.querySelector(".subtab-btn.active");
  return btn ? btn.dataset.subtab : "teamSchedule";
}

function loadActiveSubtab() {
  if (!currentTeamId) return;
  const id = currentTeamId;
  const which = activeSubtab();
  const run = which === "teamRoster" ? loadTeamRoster(id)
    : which === "teamNews" ? loadTeamNews(id)
    : loadTeamSchedule(id, Number(document.getElementById("teamSeason").value));
  run.catch(err => console.error(err));
}

async function selectTeam(teamId) {
  currentTeamId = teamId;
  rememberTeam(teamId);
  document.getElementById("teamNote").textContent = "";
  document.getElementById("teamContent").hidden = false;
  document.getElementById("teamHeader").innerHTML = `<p class="modal-empty">Loading team…</p>`;

  try {
    const data = await teamJson(`${TEAM_API}/${teamId}`, null);
    if (currentTeamId !== teamId) return;
    renderTeamHeader(data.team);
    document.getElementById("teamSearch").value = data.team.displayName;
    loadActiveSubtab();
  } catch (err) {
    document.getElementById("teamHeader").innerHTML = `<p class="modal-empty">Couldn't load that team.</p>`;
    console.error(err);
  }
}

function initTeams() {
  initTeamSeasonSelect();

  document.querySelectorAll(".subtab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".subtab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.subtab).classList.add("active");
      loadActiveSubtab();
    });
  });

  const search = document.getElementById("teamSearch");
  search.addEventListener("change", () => {
    const match = resolveTeam(search.value);
    if (match) selectTeam(match.id);
    else document.getElementById("teamNote").textContent = "No team matched that name";
  });
  search.addEventListener("input", () => {
    document.getElementById("teamNote").textContent = "";
  });
}

async function openTeamsTab() {
  const note = document.getElementById("teamNote");
  try {
    await loadTeamIndex();
    if (!currentTeamId) {
      const remembered = recallTeam();
      if (remembered) selectTeam(remembered);
      else note.textContent = `Search ${teamIndex.length} teams to see schedule, roster and news`;
    }
  } catch (err) {
    note.textContent = "Couldn't load the team list.";
    console.error(err);
  }
}

/* ---------- Playoff bracket ---------- */

// The 12-team CFP: seeds 1-4 get a bye, 5-12 play the first round.
// Each slot knows the seeds that belong in it, so real games snap into place
// as soon as the committee sets the field.
const BRACKET_SLOTS = {
  "fr-89":  { round: "fr", seeds: [8, 9],  placeholders: ["Seed 8", "Seed 9"] },
  "fr-512": { round: "fr", seeds: [5, 12], placeholders: ["Seed 5", "Seed 12"] },
  "fr-710": { round: "fr", seeds: [7, 10], placeholders: ["Seed 7", "Seed 10"] },
  "fr-611": { round: "fr", seeds: [6, 11], placeholders: ["Seed 6", "Seed 11"] },
  "qf-1": { round: "qf", byeSeed: 1, placeholders: ["Seed 1", "8/9 winner"] },
  "qf-4": { round: "qf", byeSeed: 4, placeholders: ["Seed 4", "5/12 winner"] },
  "qf-2": { round: "qf", byeSeed: 2, placeholders: ["Seed 2", "7/10 winner"] },
  "qf-3": { round: "qf", byeSeed: 3, placeholders: ["Seed 3", "6/11 winner"] },
  "sf-top":    { round: "sf", feeders: ["qf-1", "qf-4"], placeholders: ["Quarterfinal winner", "Quarterfinal winner"] },
  "sf-bottom": { round: "sf", feeders: ["qf-2", "qf-3"], placeholders: ["Quarterfinal winner", "Quarterfinal winner"] },
  "final": { round: "final", placeholders: ["Semifinal winner", "Semifinal winner"] }
};

const FIRST_12_TEAM_SEASON = 2024;
const bracketCache = new Map();

function currentSeasonYear() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

function headlineOf(ev) {
  return (ev.competitions[0].notes || []).map(n => n.headline || "").join(" ");
}

function roundOf(ev) {
  const h = headlineOf(ev);
  if (/National Championship/i.test(h)) return "final";
  if (/Semifinal/i.test(h)) return "sf";
  if (/Quarterfinal/i.test(h)) return "qf";
  if (/First Round/i.test(h)) return "fr";
  return null;
}

function bowlName(ev) {
  const h = headlineOf(ev);
  const at = h.match(/ at the (.+)$/);
  if (at) return at[1];
  if (/National Championship/i.test(h)) return "National Championship";
  if (/First Round/i.test(h)) return "First Round";
  return h;
}

function seedOf(competitor) {
  const r = competitor.curatedRank && competitor.curatedRank.current;
  return typeof r === "number" && r >= 1 && r <= 12 ? r : null;
}

function isTbd(competitor) {
  return !competitor.team || Number(competitor.team.id) < 0 || competitor.team.abbreviation === "TBD";
}

function winnerTeamId(ev) {
  if (!ev) return null;
  const comp = ev.competitions[0];
  if (!comp.status.type.completed) return null;
  const flagged = comp.competitors.find(c => c.winner === true);
  if (flagged) return String(flagged.team.id);
  const [a, b] = comp.competitors;
  const sa = Number(a && a.score), sb = Number(b && b.score);
  if (!isFinite(sa) || !isFinite(sb) || sa === sb) return null;
  return String(sa > sb ? a.team.id : b.team.id);
}

function buildBracket(events) {
  const byRound = { fr: [], qf: [], sf: [], final: [] };
  for (const ev of events) {
    const r = roundOf(ev);
    if (r) byRound[r].push(ev);
  }
  for (const r of Object.keys(byRound)) {
    byRound[r].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  const assigned = {};

  const frSlots = ["fr-89", "fr-512", "fr-710", "fr-611"];
  const frPool = byRound.fr.slice();
  for (const id of frSlots) {
    const want = BRACKET_SLOTS[id].seeds;
    const i = frPool.findIndex(ev => {
      const seeds = ev.competitions[0].competitors.map(seedOf).filter(s => s).sort((a, b) => a - b);
      return seeds.length === 2 && seeds[0] === want[0] && seeds[1] === want[1];
    });
    if (i !== -1) assigned[id] = frPool.splice(i, 1)[0];
  }

  const qfSlots = ["qf-1", "qf-4", "qf-2", "qf-3"];
  const qfPool = byRound.qf.slice();
  for (const id of qfSlots) {
    const bye = BRACKET_SLOTS[id].byeSeed;
    const i = qfPool.findIndex(ev => ev.competitions[0].competitors.some(c => seedOf(c) === bye));
    if (i !== -1) assigned[id] = qfPool.splice(i, 1)[0];
  }

  // Semifinals are matched by which quarterfinal winners are actually in them,
  // so the bracket reflects the real path rather than an assumed one.
  const sfSlots = ["sf-top", "sf-bottom"];
  const sfPool = byRound.sf.slice();
  for (const id of sfSlots) {
    const winners = BRACKET_SLOTS[id].feeders.map(f => winnerTeamId(assigned[f])).filter(Boolean);
    if (!winners.length) continue;
    const i = sfPool.findIndex(ev => ev.competitions[0].competitors.some(c => winners.includes(String(c.team.id))));
    if (i !== -1) assigned[id] = sfPool.splice(i, 1)[0];
  }

  // Anything still unplaced (TBD placeholder games) fills remaining slots by date.
  const fill = (slots, pool) => {
    for (const id of slots) {
      if (!assigned[id] && pool.length) assigned[id] = pool.shift();
    }
  };
  fill(frSlots, frPool);
  fill(qfSlots, qfPool);
  fill(sfSlots, sfPool);
  if (byRound.final.length) assigned["final"] = byRound.final[0];

  return assigned;
}

function bracketStateLabel(ev) {
  const status = ev.competitions[0].status;
  const state = status.type.state;
  if (state === "in") return `<span class="live-dot">●</span> ${status.type.shortDetail}`;
  if (state === "post") return "Final";
  return new Date(ev.date).toLocaleDateString([], { month: "short", day: "numeric" });
}

function placeholderRow(label) {
  return `<div class="b-team tbd"><span class="b-seed"></span><span class="b-name">${label}</span><span class="b-score"></span></div>`;
}

function bracketTeamRow(competitor, completed, winId) {
  const team = competitor.team;
  const seed = seedOf(competitor);
  let cls = "b-team";
  if (completed && winId) cls += String(team.id) === winId ? " winner" : " loser";
  return `
    <div class="${cls}">
      <span class="b-seed">${seed || ""}</span>
      <img class="b-logo" src="${team.logo || ""}" alt="" onerror="this.style.visibility='hidden'">
      <span class="b-name">${team.shortDisplayName || team.displayName}</span>
      <span class="b-score">${competitor.score ?? ""}</span>
    </div>`;
}

function matchHtml(slotId, ev) {
  const slot = BRACKET_SLOTS[slotId];
  const extra = slotId === "final" ? " final-match" : "";

  if (!ev) {
    return `
      <div class="match${extra}">
        <div class="b-meta"><span class="b-bowl">TBD</span><span></span></div>
        ${slot.placeholders.map(placeholderRow).join("")}
      </div>`;
  }

  const comp = ev.competitions[0];
  const live = comp.status.type.state === "in" ? " is-live" : "";
  const completed = comp.status.type.completed;
  const winId = winnerTeamId(ev);

  const competitors = comp.competitors.slice().sort((a, b) => {
    const sa = seedOf(a) ?? 99, sb = seedOf(b) ?? 99;
    return sa - sb;
  });

  const rows = competitors
    .map((c, i) => (isTbd(c) ? placeholderRow(slot.placeholders[i] || "TBD") : bracketTeamRow(c, completed, winId)))
    .join("");

  return `
    <div class="match${live}${extra}">
      <div class="b-meta">
        <span class="b-bowl">${bowlName(ev)}</span>
        <span>${bracketStateLabel(ev)}</span>
      </div>
      ${rows}
    </div>`;
}

function championHtml(finalEv) {
  const winId = winnerTeamId(finalEv);
  if (!winId) {
    return `<div class="champion-box"><div class="champ-label">Champion</div><div class="champ-name" style="color:var(--text-dim)">TBD</div></div>`;
  }
  const team = finalEv.competitions[0].competitors.find(c => String(c.team.id) === winId).team;
  return `
    <div class="champion-box">
      <div class="champ-label">Champion</div>
      <div class="champ-name">${team.displayName}</div>
      <img src="${team.logo || ""}" alt="" onerror="this.style.display='none'">
    </div>`;
}

function renderBracket(assigned) {
  const view = document.getElementById("bracketView");
  const side = (cls, frIds, qfIds, sfId) => `
    <div class="bracket-side ${cls}">
      <div class="round round-fr">
        <div class="round-label">First Round</div>
        ${frIds.map(id => matchHtml(id, assigned[id])).join("")}
      </div>
      <div class="round round-qf">
        <div class="round-label">Quarterfinals</div>
        ${qfIds.map(id => matchHtml(id, assigned[id])).join("")}
      </div>
      <div class="round round-sf">
        <div class="round-label">Semifinal</div>
        ${matchHtml(sfId, assigned[sfId])}
      </div>
    </div>`;

  view.innerHTML =
    side("left", ["fr-89", "fr-512"], ["qf-1", "qf-4"], "sf-top") +
    `<div class="bracket-center">
       <div class="round-label center-label">National Championship</div>
       ${matchHtml("final", assigned["final"])}
       ${championHtml(assigned["final"])}
     </div>` +
    side("right", ["fr-710", "fr-611"], ["qf-2", "qf-3"], "sf-bottom");
}

async function loadBracket(year, force) {
  const cached = bracketCache.get(year);
  if (cached && !force) {
    renderBracket(cached);
    return;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&seasontype=3&dates=${year}&limit=300`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("bracket fetch failed: " + res.status);
  const data = await res.json();
  const events = (data.events || []).filter(roundOf);

  // A different season may have been picked while this request was in flight.
  if (Number(document.getElementById("seasonSelect").value) !== year) return;

  const note = document.getElementById("bracketNote");
  if (!events.length) {
    document.getElementById("bracketView").innerHTML =
      `<div class="bracket-error">No playoff games found for the ${year} season.</div>`;
    note.textContent = "";
    return;
  }

  const assigned = buildBracket(events);
  bracketCache.set(year, assigned);
  renderBracket(assigned);
  note.textContent = winnerTeamId(assigned["final"])
    ? "Final result"
    : "Updates automatically as playoff games are played";
}

function activeTabName() {
  const btn = document.querySelector(".tab-btn.active");
  return btn ? btn.dataset.tab : "scores";
}

function initSeasonSelect() {
  const select = document.getElementById("seasonSelect");
  const current = currentSeasonYear();
  for (let y = current; y >= FIRST_12_TEAM_SEASON; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = `${y}-${String(y + 1).slice(2)}`;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const year = Number(select.value);
    loadBracket(year, year === currentSeasonYear()).catch(err => {
      document.getElementById("bracketView").innerHTML =
        `<div class="bracket-error">Could not load the bracket. Try again in a moment.</div>`;
      console.error(err);
    });
  });
}

function refreshBracketIfVisible() {
  if (activeTabName() !== "bracket") return Promise.resolve();
  const year = Number(document.getElementById("seasonSelect").value);
  return loadBracket(year, year === currentSeasonYear()).catch(err => console.error(err));
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "bracket") refreshBracketIfVisible();
      if (btn.dataset.tab === "previous") loadPreviousGames().catch(console.error);
      if (btn.dataset.tab === "calendar") loadCalendar().catch(console.error);
      if (btn.dataset.tab === "teams") openTeamsTab();
    });
  });
}

document.getElementById("refreshBtn").addEventListener("click", refreshAll);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll();
});

initTabs();
initSeasonSelect();
initTeams();
initModal();
refreshAll();
