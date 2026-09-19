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
    metaRight = new Date(event.date).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
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
      refreshPreviousIfVisible()
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
      if (new Date(entry.startDate) > now) continue;
      weeks.push({ label: entry.label, value: Number(entry.value), seasontype });
    }
  }
  if (!weeks.length) return;

  seasonMeta = {
    year: data.season ? data.season.year : currentSeasonYear(),
    currentWeek: data.week ? data.week.number : weeks[weeks.length - 1].value,
    currentType: data.season ? data.season.type : 2,
    weeks
  };
  initWeekSelect();
}

function initWeekSelect() {
  const select = document.getElementById("weekSelect");
  select.innerHTML = "";
  for (const w of seasonMeta.weeks.slice().reverse()) {
    const opt = document.createElement("option");
    opt.value = `${w.seasontype}:${w.value}`;
    opt.textContent = w.label;
    select.appendChild(opt);
  }
  const current = `${seasonMeta.currentType}:${seasonMeta.currentWeek}`;
  if ([...select.options].some(o => o.value === current)) select.value = current;
  select.addEventListener("change", () => loadPreviousGames().catch(console.error));
}

async function loadPreviousGames(force) {
  if (!seasonMeta) return;
  const select = document.getElementById("weekSelect");
  const key = select.value;
  if (!key) return;

  const [seasontype, week] = key.split(":").map(Number);
  const isCurrentWeek = seasontype === seasonMeta.currentType && week === seasonMeta.currentWeek;
  const cached = weekCache.get(key);
  if (cached && !force && !isCurrentWeek) {
    renderPrevious(cached);
    return;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&seasontype=${seasontype}&week=${week}&dates=${seasonMeta.year}&limit=300`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("week fetch failed: " + res.status);
  const data = await res.json();

  // A different week may have been picked while this request was in flight.
  if (select.value !== key) return;

  const finished = (data.events || [])
    .filter(ev => ev.competitions[0].status.type.completed)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  weekCache.set(key, finished);
  renderPrevious(finished);
}

function renderPrevious(events) {
  renderGrid("previousGames", events, "No completed games for this week yet.", true);
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
    const card = e.target.closest(".game-card.clickable");
    if (card) showGameDetails(card.dataset.eventId);
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest(".game-card.clickable");
    if (card) {
      e.preventDefault();
      showGameDetails(card.dataset.eventId);
    }
  });
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
    });
  });
}

document.getElementById("refreshBtn").addEventListener("click", refreshAll);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAll();
});

initTabs();
initSeasonSelect();
initModal();
refreshAll();
