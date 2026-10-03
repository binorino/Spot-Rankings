/* Study Wrapped — study sessions, live timer + camera timelapse, monthly recap,
 * calendar, leaderboard and achievements.
 *
 * Data lives where the rest of the site keeps it:
 *   Google Sheet "Sessions" tab    – one row per study session (via the Apps Script)
 *   Google Sheet "Rating Log" tab  – every rating with its date (via the Apps Script)
 *   Google Sheet "Photos" tab      – spot photos (existing)
 *   Cloudinary                     – session photos and timelapse videos
 * Users are the site's raters (REVIEWERS in script.js).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const pad2 = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const parseYMD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
  const minutesBetween = (a, b) => { let d = toMin(b) - toMin(a); if (d < 0) d += 1440; return d; };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const CAFE_AREAS = ['K-Town', 'Fryft Zone'];
  const ACCENT = { Lena: '#7b1e2b', Ashlyn: '#b8862f', Marc: '#315d72' };
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function fmtDur(min) {
    min = Math.round(min || 0);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(sec % 60)}`;
  }
  function time12(t) {
    if (!t) return '';
    let [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${pad2(m)} ${ap}`;
  }
  function niceNum(n) { return n >= 10 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toString(); }
  function longDate(s) { return parseYMD(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function shortDate(s) { return parseYMD(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function safeJSON(s, fallback) { try { const v = JSON.parse(s); return v ?? fallback; } catch (_) { return fallback; } }
  function newId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function store(key, val) { try { val === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
  function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
  function seeded(seedText) { let h = 2166136261; for (const c of seedText) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
  const placeKey = s => `${s.area}|${s.place}`;
  const isCafe = s => CAFE_AREAS.includes(s.area);
  const posterOf = url => (url.includes('/video/upload/f_auto,q_auto/') ? url.replace('/video/upload/f_auto,q_auto/', '/video/upload/so_0/') : url.replace('/video/upload/', '/video/upload/so_0/')).replace(/\.[a-z0-9]+$/i, '.jpg');
  const allSpots = () => (typeof spots !== 'undefined' && Array.isArray(spots) ? spots : []);

  // ---------------------------------------------------------------- state
  const today = new Date();
  const S = {
    person: REVIEWERS.includes(load('studyPerson')) ? load('studyPerson') : REVIEWERS[0],
    year: today.getFullYear(),
    month: today.getMonth(),
    sheetSessions: [],
    localRecs: {},            // id -> latest record we sent (overrides the sheet while it catches up)
    deleted: new Set(),
    ratingLog: [],
    loaded: false,
    deckIndex: 0,
    active: load('studyActive', null),   // the session running on this device
  };

  // ---------------------------------------------------------------- data
  async function getTextTab(name, firstHeader) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(name)}&_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return [];
      const rows = csvParse(await res.text());
      if (!rows.length || String(rows[0][0]).trim() !== firstHeader) return [];   // tab not created yet
      return rows.slice(1).filter(r => r.some(c => String(c).trim()));
    } catch (_) { return []; }
  }

  function parseSession(r) {
    return {
      id: r[0], person: r[1], place: r[2], area: r[3] || 'Other', date: r[4], start: r[5], end: r[6],
      minutes: Number(r[7]) || 0, status: r[8] || 'done', studied: r[9] || '', rating: r[10] ? Number(r[10]) : null,
      notes: r[11] || '', photos: safeJSON(r[12], []), timelapse: r[13] || '', source: r[14] || 'manual', startedAt: r[15] || '',
    };
  }

  async function loadStudyData() {
    const [sessRows, logRows] = await Promise.all([getTextTab('Sessions', 'Session ID'), getTextTab('Rating Log', 'Logged At')]);
    S.sheetSessions = sessRows.map(parseSession).filter(s => s.id && REVIEWERS.includes(s.person) && /^\d{4}-\d{2}-\d{2}$/.test(s.date));
    S.ratingLog = logRows.map(r => ({ loggedAt: r[0], date: r[1], person: r[2], place: r[3], area: r[4], overall: r[5] === '' ? null : Number(r[5]), notes: r[6] || '' }))
      .filter(r => REVIEWERS.includes(r.person) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    S.loaded = true;
    renderStudy();
  }

  function allSessions() {
    const map = new Map(S.sheetSessions.map(s => [s.id, s]));
    for (const [id, rec] of Object.entries(S.localRecs)) map.set(id, rec);
    return [...map.values()].filter(s => !S.deleted.has(s.id));
  }
  const doneSessions = person => allSessions().filter(s => s.person === person && s.status === 'done')
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  function studyingNow() {
    const cutoff = Date.now() - 16 * 3600e3;
    return allSessions().filter(s => s.status === 'active' && Date.parse(s.startedAt) > cutoff);
  }
  function spotPhotosBy(person) {
    return (window.photoLog || []).filter(p => p.person === person && p.date);
  }

  // ---------------------------------------------------------------- saving
  const sendQueue = {};
  function saveSession(rec) {
    S.localRecs[rec.id] = { ...rec };
    const payload = { action: 'session', person: rec.person, session: rec };
    sendQueue[rec.id] = (sendQueue[rec.id] || Promise.resolve()).catch(() => {}).then(async () => {
      try { await sendPayload(payload); removeFromOutbox(rec.id); }
      catch (e) {
        if (/reach/i.test(e.message)) { addToOutbox(payload); return; }   // offline: retry later
        throw e;
      }
    });
    return sendQueue[rec.id];
  }
  function addToOutbox(payload) { const box = load('studyOutbox', {}); box[payload.session.id] = payload; store('studyOutbox', box); }
  function removeFromOutbox(id) { const box = load('studyOutbox', {}); if (box[id]) { delete box[id]; store('studyOutbox', box); } }
  async function flushOutbox() {
    const box = load('studyOutbox', {});
    for (const payload of Object.values(box)) {
      S.localRecs[payload.session.id] = payload.session;
      try { await sendPayload(payload); removeFromOutbox(payload.session.id); } catch (_) { break; }
    }
  }
  async function deleteSession(s) {
    await sendPayload({ action: 'deleteSession', person: s.person, id: s.id });
    S.deleted.add(s.id); delete S.localRecs[s.id];
  }
  function refreshSoon() { setTimeout(() => loadStudyData().catch(() => {}), 4000); }

  // ---------------------------------------------------------------- stats
  function streaksOf(dates) {
    const days = [...new Set(dates)].sort();
    let best = 0, run = 0, prev = null, bestEnd = null;
    for (const d of days) {
      const t = parseYMD(d).getTime();
      run = prev !== null && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1;
      if (run > best) { best = run; bestEnd = d; }
      prev = t;
    }
    let bestStart = null;
    if (bestEnd) { const s = parseYMD(bestEnd); s.setDate(s.getDate() - best + 1); bestStart = ymd(s); }
    return { best, bestStart, bestEnd };
  }

  function groupPlaces(list) {
    const m = new Map();
    for (const s of list) {
      const k = placeKey(s), g = m.get(k) || { place: s.place, area: s.area, count: 0, minutes: 0 };
      g.count++; g.minutes += s.minutes; m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes || a.place.localeCompare(b.place));
  }

  function statsFor(person, y, m) {
    const all = doneSessions(person);
    const key = `${y}-${pad2(m + 1)}`;
    const ms = all.filter(s => s.date.startsWith(key));
    const dim = new Date(y, m + 1, 0).getDate();
    const now = new Date();
    const isCurrent = y === now.getFullYear() && m === now.getMonth();
    const periodDays = isCurrent ? Math.max(7, now.getDate()) : dim;   // at least a week, so day 2 doesn't extrapolate wildly
    const total = ms.reduce((a, s) => a + s.minutes, 0);
    const places = groupPlaces(ms);
    const firstSeen = new Map();
    for (const s of all) if (!firstSeen.has(placeKey(s))) firstSeen.set(placeKey(s), s.date);
    const newPlaces = places.filter(p => (firstSeen.get(placeKey(p)) || '').startsWith(key));
    const days = [...new Set(ms.map(s => s.date))].sort();
    const longest = ms.reduce((a, s) => (!a || s.minutes > a.minutes ? s : a), null);
    const streak = streaksOf(ms.map(s => s.date));
    const sessionPhotos = ms.flatMap(s => s.photos.map(url => ({ url, date: s.date, place: s.place })));
    const spotPhotos = spotPhotosBy(person).filter(p => p.date.startsWith(key)).map(p => ({ url: p.url, date: p.date, place: p.place }));
    const photos = [...sessionPhotos, ...spotPhotos];
    const timelapses = ms.filter(s => s.timelapse).map(s => ({ url: s.timelapse, date: s.date, place: s.place, minutes: s.minutes }));
    const ratings = S.ratingLog.filter(r => r.person === person && r.date.startsWith(key));

    // favourite: average of this month's ratings (session stars x2 and 0–10 spot ratings)
    const score = new Map();
    const addScore = (k, place, area, v) => { const g = score.get(k) || { place, area, sum: 0, n: 0 }; g.sum += v; g.n++; score.set(k, g); };
    ms.filter(s => s.rating).forEach(s => addScore(placeKey(s), s.place, s.area, s.rating * 2));
    ratings.filter(r => Number.isFinite(r.overall)).forEach(r => addScore(`${r.area}|${r.place}`, r.place, r.area, r.overall));
    let favorite = [...score.values()].map(g => ({ ...g, avg: g.sum / g.n })).sort((a, b) => b.avg - a.avg || b.n - a.n)[0] || null;
    let favoriteSource = 'your ratings this month';
    if (!favorite) {
      const scored = places.map(p => { const sp = allSpots().find(x => x.name === p.place && x.area === p.area); return sp ? { ...p, avg: personalScore(sp, person) } : null; })
        .filter(x => x && Number.isFinite(x.avg)).sort((a, b) => b.avg - a.avg);
      if (scored[0]) { favorite = scored[0]; favoriteSource = 'your overall spot ratings'; }
    }
    const rateCounts = groupPlaces(ratings.map(r => ({ place: r.place, area: r.area, minutes: 0 })));
    const avgRating = list => { const v = list.filter(r => Number.isFinite(r.overall)).map(r => r.overall); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const prevKey = m === 0 ? `${y - 1}-12` : `${y}-${pad2(m)}`;
    const ratingAvg = avgRating(ratings), prevRatingAvg = avgRating(S.ratingLog.filter(r => r.person === person && r.date.startsWith(prevKey)));

    return {
      person, y, m, key, dim, isCurrent, sessions: ms, all, total, count: ms.length, places, newPlaces, days,
      avgSession: ms.length ? total / ms.length : 0, weekly: periodDays ? total / (periodDays / 7) : 0, longest, streak,
      photos, timelapses, ratings, favorite, favoriteSource, mostRated: rateCounts[0] || null, ratingAvg, prevRatingAvg,
      cafes: places.filter(isCafe), campus: places.filter(p => p.area === 'On Campus'),
    };
  }

  // ---------------------------------------------------------------- fun comparisons
  const UNITS = [
    { min: 120, one: 'movie', many: 'movies', say: n => `about the length of ${n}` },
    { min: 22, one: 'sitcom episode', many: 'sitcom episodes', say: n => `roughly ${n} back to back` },
    { min: 205, one: 'Eras Tour show', many: 'Eras Tour shows', say: n => `the same as sitting through ${n}` },
    { min: 380, one: 'drive from LA to San Francisco', many: 'drives from LA to San Francisco', say: n => `long enough for ${n}` },
    { min: 690, one: 'flight from LAX to Tokyo', many: 'flights from LAX to Tokyo', say: n => `that's ${n}` },
    { min: 686, one: 'Lord of the Rings extended marathon', many: 'Lord of the Rings extended marathons', say: n => `enough for ${n}` },
    { min: 3.5, one: 'song', many: 'songs', say: n => `that's ${n} on repeat` },
    { min: 80, one: 'USC lecture', many: 'USC lectures', say: n => `about ${n} (but you chose these)` },
    { min: 210, one: 'Trojans football game', many: 'Trojans football games', say: n => `the length of ${n}` },
    { min: 45, one: 'podcast episode', many: 'podcast episodes', say: n => `${n} worth of listening` },
  ];
  function pickUnits(minutes, count, seed) {
    const rnd = seeded(seed);
    const fit = UNITS.filter(u => { const n = minutes / u.min; return n >= 1.5 && n <= 120; })
      .map(u => ({ u, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, count).map(x => x.u);
    return fit.map(u => u.say(`${niceNum(minutes / u.min)} ${u.many}`));
  }
  function comparisons(st) {
    if (!st.count) return [];
    const seed = `${st.person}-${st.key}`;
    const lines = [];
    const [a, b] = pickUnits(st.total, 2, seed);
    if (a) lines.push(`You studied for ${fmtDur(st.total)} this month — ${a}.`);
    if (st.total >= 1440) lines.push(`${fmtDur(st.total)} is ${niceNum(st.total / 1440)} full days of studying. Sleep is also allowed.`);
    if (b) lines.push(`Put another way: ${b}.`);
    const [w] = pickUnits(st.weekly, 1, seed + 'w');
    if (w && st.weekly > 0) lines.push(`You averaged ${fmtDur(st.weekly)} a week — ${w}, every single week.`);
    if (st.places.length >= 5) lines.push(`You visited ${st.places.length} different study spots — that's basically a study-tour itinerary.`);
    else if (st.places.length >= 2) lines.push(`${st.places.length} different study spots this month. A tasteful rotation.`);
    else if (st.places.length === 1) lines.push(`Every session at ${st.places[0].place}. Loyalty like that deserves a punch card.`);
    if (st.cafes.length >= 2) lines.push(`You studied at ${st.cafes.length} different cafés this month — barista recognition: likely.`);
    if (st.campus.length && !st.cafes.length && st.places.every(p => p.area === 'On Campus')) lines.push('Every session was on campus. Trojan to the core.');
    if (st.longest && st.longest.minutes >= 180) lines.push(`Your longest session (${fmtDur(st.longest.minutes)}) outlasted a three-hour movie. Respect.`);
    if (st.streak.best >= 3) lines.push(`A ${st.streak.best}-day streak. Your study spot started saving you a seat.`);
    return lines;
  }

  // ---------------------------------------------------------------- achievements
  function weekendKey(d) { const x = parseYMD(d); if (x.getDay() === 0) x.setDate(x.getDate() - 1); return ymd(x); }
  const BADGES = [
    { id: 'regular', icon: '☕', name: 'The Regular', test: st => { const p = groupPlaces(st.list)[0]; return p && p.count >= 10 ? `Studied at ${p.place} ${p.count} times` : null; } },
    { id: 'tourist', icon: '🧳', name: 'Study Tourist', test: st => { const n = groupPlaces(st.list).length; return n >= 5 ? `Explored ${n} different study spots` : null; } },
    { id: 'explorer', icon: '🧭', name: 'Explorer', monthOnly: true, test: st => st.month.newPlaces.length ? `Found ${plural(st.month.newPlaces.length, 'new spot')} this month` : null },
    { id: 'early', icon: '🌅', name: 'Early Bird', test: st => { const n = st.list.filter(s => s.start && toMin(s.start) < 8 * 60).length; return n >= 3 ? `${n} sessions started before 8 AM` : null; } },
    { id: 'owl', icon: '🦉', name: 'Night Owl', test: st => { const n = st.list.filter(s => s.end && (toMin(s.end) >= 23 * 60 || (s.start && toMin(s.end) < toMin(s.start)))).length; return n >= 3 ? `${n} sessions that ran past 11 PM` : null; } },
    { id: 'marathon', icon: '🏃', name: 'Marathoner', test: st => { const l = st.list.reduce((a, s) => Math.max(a, s.minutes), 0); return l >= 240 ? `A ${fmtDur(l)} session` : null; } },
    { id: 'cafe', icon: '🥐', name: 'Café Hopper', test: st => { const n = groupPlaces(st.list.filter(isCafe)).length; return n >= 3 ? `Studied at ${n} different cafés` : null; } },
    { id: 'streak', icon: '👑', name: 'Consistency Crown', test: st => { const b = streaksOf(st.list.map(s => s.date)).best; return b >= 7 ? `A ${b}-day study streak` : null; } },
    { id: 'weekend', icon: '🛹', name: 'Weekend Warrior', test: st => { const n = new Set(st.list.filter(s => [0, 6].includes(parseYMD(s.date).getDay())).map(s => weekendKey(s.date))).size; return n >= 3 ? `Studied on ${n} different weekends` : null; } },
    { id: 'flyer', icon: '✈️', name: 'Frequent Flyer', test: st => { const n = groupPlaces(st.list).length; return n >= 10 ? `${n} different locations logged` : null; } },
    { id: 'shutter', icon: '📸', name: 'Shutterbug', test: st => { const n = st.list.reduce((a, s) => a + s.photos.length, 0) + st.spotPhotos; return n >= 10 ? `${n} photos logged` : null; } },
    { id: 'director', icon: '🎬', name: 'Timelapse Director', test: st => { const n = st.list.filter(s => s.timelapse).length; return n ? `${plural(n, 'timelapse')} recorded` : null; } },
  ];
  function achievementsFor(st) {
    const monthStart = `${st.key}-01`, monthEnd = `${st.key}-${pad2(st.dim)}`;
    const upTo = st.all.filter(s => s.date <= monthEnd), before = st.all.filter(s => s.date < monthStart);
    const photosUpTo = spotPhotosBy(st.person).filter(p => p.date <= monthEnd).length;
    const photosBefore = spotPhotosBy(st.person).filter(p => p.date < monthStart).length;
    return BADGES.map(b => {
      const desc = b.test({ list: upTo, month: st, spotPhotos: photosUpTo });
      if (!desc) return null;
      const earlier = b.monthOnly ? null : b.test({ list: before, month: { newPlaces: [] }, spotPhotos: photosBefore });
      return { ...b, desc, isNew: b.monthOnly || !earlier };
    }).filter(Boolean);
  }

  // ---------------------------------------------------------------- rendering: page
  const el = id => document.getElementById(id);

  function renderStudy() {
    const view = el('studyView');
    if (!view) return;
    view.style.setProperty('--accent', ACCENT[S.person] || '#7b1e2b');
    view.dataset.person = S.person;
    renderPersonPicker();
    el('monthLabel').textContent = `${MONTHS[S.month]} ${S.year}`;
    const now = new Date();
    el('nextMonth').disabled = S.year > now.getFullYear() || (S.year === now.getFullYear() && S.month >= now.getMonth());
    renderStudyingNow();
    renderLive();
    if (!S.loaded) { el('wrappedSummary').innerHTML = '<div class="study-loading">Loading study sessions…</div>'; return; }
    const st = statsFor(S.person, S.year, S.month);
    renderSummary(st);
    renderDeck(st);
    renderCalendar(st);
    renderLeaderboard();
    renderAchievements(st);
  }

  function renderPersonPicker() {
    el('studyPersonPicker').innerHTML = REVIEWERS.map(p => `<button type="button" class="person-pill${p === S.person ? ' active' : ''}" data-person="${esc(p)}" style="--pill:${ACCENT[p]}" aria-pressed="${p === S.person}"><span class="pill-sprite">${spriteMarkup(p)}</span>${esc(p)}</button>`).join('');
  }

  function renderStudyingNow() {
    const now = studyingNow().filter(s => !(S.active && s.id === S.active.id));
    el('studyingNow').innerHTML = now.length ? now.map(s => `<span class="now-chip" style="--pill:${ACCENT[s.person]}"><i></i>${esc(s.person)} is studying at <b>${esc(s.place)}</b> · since ${esc(time12(s.start))}</span>`).join('') : '';
  }

  function renderSummary(st) {
    const tile = (label, value, sub = '') => `<div class="sum-tile"><span class="sum-label">${label}</span><b class="sum-value">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    if (!st.count) {
      el('wrappedSummary').innerHTML = `<div class="study-empty"><p class="eyebrow">${MONTHS[st.m].toUpperCase()} // NO SESSIONS YET</p><h3>Nothing logged for ${MONTHS[st.m]} yet.</h3><p>Start a session or log one you already did — your Wrapped builds itself from there.</p></div>`;
      return;
    }
    const most = st.places[0];
    el('wrappedSummary').innerHTML = `
      <div class="sum-head"><p class="eyebrow">MONTHLY SUMMARY // ${esc(st.person.toUpperCase())}</p></div>
      <div class="sum-grid">
        ${tile('Total time', fmtDur(st.total))}
        ${tile('Sessions', st.count)}
        ${tile('Locations', st.places.length)}
        ${tile('Most frequented', esc(most.place), plural(most.count, 'visit'))}
        ${tile('Favorite spot', st.favorite ? esc(st.favorite.place) : '—', st.favorite ? `${(st.favorite.avg).toFixed(1)}/10 · ${st.favoriteSource}` : 'rate a session to unlock')}
        ${tile('Avg session', fmtDur(st.avgSession))}
        ${tile('Avg per week', fmtDur(st.weekly))}
        ${tile('Longest session', fmtDur(st.longest.minutes), `${esc(st.longest.place)} · ${shortDate(st.longest.date)}`)}
        ${tile('Longest streak', plural(st.streak.best, 'day'))}
        ${tile('Days studied', `${st.days.length}<small>/${st.isCurrent ? new Date().getDate() : st.dim}</small>`)}
        ${tile('New spots', st.newPlaces.length)}
        ${tile('Photos · timelapses', `${st.photos.length} · ${st.timelapses.length}`)}
      </div>`;
  }

  // ---------------------------------------------------------------- rendering: the Wrapped deck
  function miniMonth(st) {
    const first = new Date(st.y, st.m, 1).getDay(), set = new Set(st.days);
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<i class="mm-pad"></i>';
    for (let d = 1; d <= st.dim; d++) cells += `<i class="${set.has(`${st.key}-${pad2(d)}`) ? 'on' : ''}" style="--d:${d}"></i>`;
    return `<div class="mini-month">${WEEKDAYS.map(w => `<b>${w[0]}</b>`).join('')}${cells}</div>`;
  }

  function deckCards(st) {
    const P = esc(st.person), mon = MONTHS[st.m];
    if (!st.count) {
      return [{ theme: 'cardinal', html: `<p class="eyebrow">STUDY WRAPPED // ${mon.toUpperCase()} ${st.y}</p><h2 class="wrap-title">${P}'s ${mon}, still wrapped.</h2><p class="wrap-copy">No sessions yet this month. Hit <b>Start Studying</b> and this deck fills itself in.</p><div class="wrap-sprite">${spriteMarkup(st.person)}</div>` }];
    }
    const comp = comparisons(st);
    const cards = [];
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">STUDY WRAPPED // ${mon.toUpperCase()} ${st.y}</p><h2 class="wrap-title">${P}'s ${mon},<br><em>wrapped.</em></h2><p class="wrap-copy">${plural(st.count, 'session')}, ${plural(st.places.length, 'spot')} and a lot of laptop glow. Tap → to unwrap it.</p><div class="wrap-sprite">${spriteMarkup(st.person)}</div>` });
    cards.push({ theme: 'terminal', html: `<p class="eyebrow">01 // TOTAL TIME STUDIED</p><div class="wrap-prompt">C:\\STUDY\\${mon.toUpperCase().slice(0, 3)}&gt; total</div><div class="wrap-big" data-countup="dur" data-to="${st.total}">${fmtDur(st.total)}</div><p class="wrap-copy">${esc(comp[0] || '')}</p>` });
    cards.push({ theme: 'paper', html: `<p class="eyebrow">02 // DATES YOU STUDIED</p><h2 class="wrap-title"><span data-countup="num" data-to="${st.days.length}">${st.days.length}</span> of ${st.isCurrent ? new Date().getDate() : st.dim} days.</h2>${miniMonth(st)}<p class="wrap-copy">First session ${shortDate(st.days[0])}, latest ${shortDate(st.days[st.days.length - 1])}.</p>` });
    cards.push({ theme: 'postcard', html: `<p class="eyebrow">03 // STUDY FREQUENCY</p><div class="wrap-trio"><div><b data-countup="num" data-to="${st.count}">${st.count}</b><span>sessions</span></div><div><b>${fmtDur(st.avgSession)}</b><span>average session</span></div><div><b>${fmtDur(st.longest.minutes)}</b><span>longest · ${esc(st.longest.place)}</span></div></div><p class="wrap-copy">${st.count / Math.max(1, st.days.length) > 1.3 ? 'Double sessions on the regular. You love a comeback.' : 'Steady, one solid session at a time.'}</p>` });
    const weeklyLine = comp.find(c => c.startsWith('You averaged')) || '';
    cards.push({ theme: 'blue', html: `<p class="eyebrow">04 // WEEKLY AVERAGE</p><div class="wrap-big" data-countup="dur" data-to="${Math.round(st.weekly)}">${fmtDur(st.weekly)}</div><p class="wrap-sub">per week</p><p class="wrap-copy">${esc(weeklyLine)}</p>` });
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">05 // STUDY STREAK</p><div class="wrap-big">🔥 <span data-countup="num" data-to="${st.streak.best}">${st.streak.best}</span></div><p class="wrap-sub">${st.streak.best === 1 ? 'day in a row' : 'days in a row'}</p><p class="wrap-copy">${st.streak.best > 1 ? `${shortDate(st.streak.bestStart)} → ${shortDate(st.streak.bestEnd)}. The chain held.` : 'Every streak starts with day one. Next month: two.'}</p>` });
    const maxCount = st.places[0].count;
    cards.push({ theme: 'paper', html: `<p class="eyebrow">06 // MOST VISITED</p><h2 class="wrap-title">Your rotation.</h2><ol class="wrap-bars">${st.places.slice(0, 5).map((p, i) => `<li style="--w:${Math.max(12, p.count / maxCount * 100)}%;--i:${i}"><span>${i + 1}. ${esc(p.place)}</span><b>${plural(p.count, 'visit')} · ${fmtDur(p.minutes)}</b></li>`).join('')}</ol>` });
    cards.push({ theme: 'terminal', html: `<p class="eyebrow">07 // NEW PLACES EXPLORED</p>${st.newPlaces.length ? `<div class="wrap-big" data-countup="num" data-to="${st.newPlaces.length}">${st.newPlaces.length}</div><p class="wrap-sub">${st.newPlaces.length === 1 ? 'new spot unlocked' : 'new spots unlocked'}</p><ul class="wrap-list">${st.newPlaces.map(p => `<li>+ ${esc(p.place)} <small>${esc(p.area)}</small></li>`).join('')}</ul>` : `<h2 class="wrap-title">No new spots.</h2><p class="wrap-copy">You know what you like. Next month, try one place off the list.</p>`}` });
    const fav = st.favorite;
    const trend = st.ratingAvg != null && st.prevRatingAvg != null ? ` Your average rating went ${st.ratingAvg >= st.prevRatingAvg ? '↑ up' : '↓ down'} from ${st.prevRatingAvg.toFixed(1)} to ${st.ratingAvg.toFixed(1)}.` : '';
    cards.push({ theme: 'postcard', html: `<p class="eyebrow">08 // FAVORITE SPOT</p>${fav ? `<h2 class="wrap-title">${esc(fav.place)}</h2><div class="wrap-big small" data-countup="dec" data-to="${fav.avg.toFixed(1)}">${fav.avg.toFixed(1)}<small>/10</small></div><p class="wrap-copy">Highest rated by ${esc(st.favoriteSource)}.${st.ratings.length ? ` You logged ${plural(st.ratings.length, 'spot rating')} this month${st.mostRated && st.mostRated.count > 1 ? `, rating ${esc(st.mostRated.place)} the most (${st.mostRated.count}×)` : ''}.` : ''}${trend}</p>` : `<h2 class="wrap-title">No favorite yet.</h2><p class="wrap-copy">Rate your sessions (★) and your favorite spot shows up here.</p>`}` });
    if (st.photos.length) cards.push({ theme: 'paper', html: `<p class="eyebrow">09 // PHOTOS FROM ${mon.toUpperCase()}</p><div class="wrap-collage">${st.photos.slice(0, 6).map((p, i) => `<figure style="--r:${[-3, 2, -1, 3, -2, 1][i]}deg"><img src="${esc(p.url)}" alt="${esc(p.place)}" loading="lazy"><figcaption>${esc(p.place)} · ${shortDate(p.date)}</figcaption></figure>`).join('')}</div>${st.photos.length > 6 ? `<p class="wrap-sub">+ ${st.photos.length - 6} more in the calendar</p>` : ''}` });
    if (st.timelapses.length) cards.push({ theme: 'terminal', html: `<p class="eyebrow">10 // TIMELAPSES</p><div class="wrap-reels">${st.timelapses.slice(0, 3).map(t => `<figure><video src="${esc(t.url)}" poster="${esc(posterOf(t.url))}" muted loop playsinline preload="none"></video><figcaption>${esc(t.place)} · ${shortDate(t.date)} · ${fmtDur(t.minutes)}</figcaption></figure>`).join('')}</div>` });
    const badges = achievementsFor(st).filter(b => b.isNew);
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">11 // FUN FACTS</p><ul class="wrap-facts">${comp.filter(c => c !== comp[0] && c !== weeklyLine).slice(0, 5).map(c => `<li>${esc(c)}</li>`).join('')}</ul>${badges.length ? `<div class="wrap-badges">${badges.map(b => `<span title="${esc(b.desc)}">${b.icon} ${esc(b.name)}</span>`).join('')}</div>` : ''}<p class="wrap-sign">— that's a wrap, ${P}. ✦</p>` });
    return cards;
  }

  function renderDeck(st) {
    const cards = deckCards(st);
    S.deckIndex = Math.min(S.deckIndex, cards.length - 1);
    el('wrappedDeck').innerHTML = `
      <div class="deck-progress">${cards.map((_, i) => `<i class="${i < S.deckIndex ? 'done' : i === S.deckIndex ? 'now' : ''}"></i>`).join('')}</div>
      <div class="deck-stage" tabindex="0" aria-roledescription="carousel" aria-label="Study Wrapped for ${MONTHS[st.m]}">
        ${cards.map((c, i) => `<article class="wrap-card theme-${c.theme}${i === S.deckIndex ? ' active' : ''}" aria-hidden="${i !== S.deckIndex}" data-i="${i}">${c.html}</article>`).join('')}
        <button type="button" class="deck-nav prev" aria-label="Previous card" ${S.deckIndex === 0 ? 'disabled' : ''}>‹</button>
        <button type="button" class="deck-nav next" aria-label="Next card" ${S.deckIndex === cards.length - 1 ? 'disabled' : ''}>›</button>
      </div>
      <p class="deck-count">${S.deckIndex + 1} / ${cards.length}</p>`;
    animateCard(el('wrappedDeck').querySelector('.wrap-card.active'));
  }

  function goDeck(delta) {
    const cardsEls = [...el('wrappedDeck').querySelectorAll('.wrap-card')];
    const next = Math.max(0, Math.min(cardsEls.length - 1, S.deckIndex + delta));
    if (next === S.deckIndex) return;
    cardsEls[S.deckIndex].classList.remove('active'); cardsEls[S.deckIndex].setAttribute('aria-hidden', 'true');
    cardsEls[S.deckIndex].querySelectorAll('video').forEach(v => v.pause());
    S.deckIndex = next;
    const c = cardsEls[next];
    c.classList.toggle('from-left', delta < 0);
    c.classList.add('active'); c.setAttribute('aria-hidden', 'false');
    el('wrappedDeck').querySelectorAll('.deck-progress i').forEach((i, n) => { i.className = n < next ? 'done' : n === next ? 'now' : ''; });
    el('wrappedDeck').querySelector('.deck-nav.prev').disabled = next === 0;
    el('wrappedDeck').querySelector('.deck-nav.next').disabled = next === cardsEls.length - 1;
    el('wrappedDeck').querySelector('.deck-count').textContent = `${next + 1} / ${cardsEls.length}`;
    animateCard(c);
  }

  function animateCard(card) {
    if (!card) return;
    card.querySelectorAll('video').forEach(v => { v.preload = 'auto'; v.play().catch(() => {}); });
    if (reduceMotion()) return;
    card.querySelectorAll('[data-countup]').forEach(node => {
      const to = Number(node.dataset.to), kind = node.dataset.countup, t0 = performance.now(), dur = 900;
      const suffix = node.querySelector('small')?.outerHTML || '';
      const tick = t => {
        const k = Math.min(1, (t - t0) / dur), v = to * (1 - Math.pow(1 - k, 3));
        node.innerHTML = (kind === 'dur' ? fmtDur(v) : kind === 'dec' ? v.toFixed(1) : Math.round(v)) + suffix;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---------------------------------------------------------------- rendering: calendar
  function dayActivity(person, date) {
    const sessions = doneSessions(person).filter(s => s.date === date);
    const ratings = S.ratingLog.filter(r => r.person === person && r.date === date);
    const photos = [
      ...sessions.flatMap(s => s.photos.map(url => ({ url, place: s.place }))),
      ...spotPhotosBy(person).filter(p => p.date === date).map(p => ({ url: p.url, place: p.place })),
    ];
    const timelapses = sessions.filter(s => s.timelapse);
    return { sessions, ratings, photos, timelapses, minutes: sessions.reduce((a, s) => a + s.minutes, 0) };
  }
  const level = min => (min <= 0 ? 0 : min < 60 ? 1 : min < 120 ? 2 : min < 240 ? 3 : 4);

  function renderCalendar(st) {
    const first = new Date(st.y, st.m, 1).getDay(), todayKey = ymd(new Date());
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span class="cal-pad"></span>';
    for (let d = 1; d <= st.dim; d++) {
      const date = `${st.key}-${pad2(d)}`, a = dayActivity(st.person, date), future = date > todayKey;
      const marks = [a.sessions.length > 1 ? `<i class="mk-multi" title="${a.sessions.length} sessions">${a.sessions.length}</i>` : '', a.ratings.length ? '<i class="mk-rate" title="Rated a spot">★</i>' : '', a.photos.length ? '<i class="mk-photo" title="Photos">◫</i>' : '', a.timelapses.length ? '<i class="mk-tl" title="Timelapse">▶</i>' : ''].join('');
      const label = `${longDate(date)}: ${a.minutes ? fmtDur(a.minutes) + ' studied' : 'no study'}${a.sessions.length > 1 ? `, ${a.sessions.length} sessions` : ''}`;
      cells += `<button type="button" class="cal-day lv${level(a.minutes)}${date === todayKey ? ' today' : ''}" data-date="${date}" ${future ? 'disabled' : ''} aria-label="${esc(label)}" title="${esc(label)}"><span class="cal-num">${d}</span>${a.minutes ? `<span class="cal-min">${fmtDur(a.minutes)}</span>` : ''}<span class="cal-marks">${marks}</span></button>`;
    }
    el('studyCalendar').innerHTML = `
      <div class="panel-head"><p class="eyebrow">STUDY CALENDAR // ${MONTHS[st.m].toUpperCase()}</p><h3>${esc(st.person)}'s month</h3></div>
      <div class="cal-grid">${WEEKDAYS.map(w => `<span class="cal-wd">${w}</span>`).join('')}${cells}</div>
      <div class="cal-legend"><span>Less</span>${[0, 1, 2, 3, 4].map(l => `<i class="lv${l}"></i>`).join('')}<span>More</span><span class="cal-key"><i class="mk-multi">2</i> sessions <i class="mk-rate">★</i> rating <i class="mk-photo">◫</i> photo <i class="mk-tl">▶</i> timelapse</span></div>`;
  }

  // ---------------------------------------------------------------- day drawer
  let viewer = { photos: [], i: 0 };
  function openDay(date) {
    const a = dayActivity(S.person, date);
    const places = groupPlaces(a.sessions);
    viewer = { photos: a.photos, i: 0 };
    const sessionHTML = a.sessions.map(s => `
      <li class="day-session" data-id="${esc(s.id)}">
        <div><b>${esc(s.place)}</b> <small>${esc(s.area)}</small></div>
        <div class="day-meta">${s.start ? `${esc(time12(s.start))}${s.end ? ` – ${esc(time12(s.end))}` : ''} · ` : ''}${fmtDur(s.minutes)}${s.rating ? ` · <span class="stars-read" aria-label="${s.rating} of 5">${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)}</span>` : ''}${s.source === 'live' ? ' · <span class="live-tag">timed</span>' : ''}</div>
        ${s.studied ? `<div class="day-studied">📚 ${esc(s.studied)}</div>` : ''}
        ${s.notes ? `<p class="day-notes">${esc(s.notes)}</p>` : ''}
        <div class="day-row-actions"><button type="button" class="link-btn" data-rate-session="${esc(s.id)}">Rate this spot →</button><button type="button" class="link-btn danger" data-delete-session="${esc(s.id)}">Delete</button></div>
      </li>`).join('');
    el('dayDrawerBody').innerHTML = `
      <p class="eyebrow">${esc(S.person.toUpperCase())} // DAY LOG</p>
      <h2>${longDate(date)}</h2>
      <div class="day-stats"><div><b>${fmtDur(a.minutes)}</b><span>studied</span></div><div><b>${a.sessions.length}</b><span>${a.sessions.length === 1 ? 'session' : 'sessions'}</span></div><div><b>${places.length}</b><span>${places.length === 1 ? 'location' : 'locations'}</span></div></div>
      ${places.length ? `<div class="day-chips">${places.map(p => `<span>📍 ${esc(p.place)}</span>`).join('')}</div>` : ''}
      ${a.photos.length ? `<section class="day-viewer"><div class="viewer-frame"><img id="viewerImg" src="${esc(a.photos[0].url)}" alt=""><button type="button" class="viewer-nav prev" data-viewer="-1" aria-label="Previous photo">‹</button><button type="button" class="viewer-nav next" data-viewer="1" aria-label="Next photo">›</button><span class="viewer-count" id="viewerCount"></span></div><div class="viewer-thumbs">${a.photos.map((p, i) => `<button type="button" data-viewer-go="${i}" aria-label="Photo ${i + 1}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join('')}</div></section>` : ''}
      ${a.timelapses.length ? `<section><p class="eyebrow">TIMELAPSE${a.timelapses.length > 1 ? 'S' : ''}</p>${a.timelapses.map(s => `<figure class="day-reel"><video src="${esc(s.timelapse)}" poster="${esc(posterOf(s.timelapse))}" controls playsinline loop preload="metadata"></video><figcaption>${esc(s.place)} · ${esc(time12(s.start))}${s.end ? ` – ${esc(time12(s.end))}` : ''}</figcaption></figure>`).join('')}</section>` : ''}
      ${a.sessions.length ? `<section><p class="eyebrow">SESSIONS</p><ul class="day-sessions">${sessionHTML}</ul></section>` : ''}
      ${a.ratings.length ? `<section><p class="eyebrow">RATINGS GIVEN</p><ul class="day-ratings">${a.ratings.map(r => `<li><b>${esc(r.place)}</b> <small>${esc(r.area)}</small><span>${Number.isFinite(r.overall) ? r.overall.toFixed(1) + '/10' : '—'}</span>${r.notes ? `<p>${esc(r.notes)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}
      ${!a.sessions.length && !a.ratings.length && !a.photos.length ? `<div class="study-empty small"><h3>No study logged.</h3><p>Forgot to log it?</p><button type="button" class="study-btn" data-log-for="${date}">+ Log a session for this day</button></div>` : `<button type="button" class="study-btn ghost" data-log-for="${date}">+ Add another session</button>`}`;
    updateViewer();
    el('dayDrawer').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    el('dayDrawer').querySelector('.drawer-panel').focus();
  }
  function updateViewer() {
    const img = el('viewerImg'); if (!img || !viewer.photos.length) return;
    img.src = viewer.photos[viewer.i].url;
    img.alt = `Photo at ${viewer.photos[viewer.i].place}`;
    el('viewerCount').textContent = `${viewer.i + 1} / ${viewer.photos.length} · ${viewer.photos[viewer.i].place}`;
    el('dayDrawerBody').querySelectorAll('[data-viewer-go]').forEach((b, i) => b.classList.toggle('on', i === viewer.i));
    el('dayDrawerBody').querySelectorAll('.viewer-nav').forEach(b => { b.hidden = viewer.photos.length < 2; });
  }
  function closeDrawer() {
    el('dayDrawer').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    el('dayDrawer').querySelectorAll('video').forEach(v => v.pause());
  }

  // ---------------------------------------------------------------- leaderboard + achievements
  function renderLeaderboard() {
    const stats = REVIEWERS.map(p => statsFor(p, S.year, S.month));
    const cats = [
      { icon: '🏆', title: 'Study Champion', val: s => s.total, fmt: v => fmtDur(v) },
      { icon: '📚', title: 'Session Stacker', val: s => s.count, fmt: v => plural(v, 'session') },
      { icon: '🔥', title: 'Streak Master', val: s => s.streak.best, fmt: v => `${v}-day streak` },
      { icon: '🗺️', title: 'Explorer', val: s => s.newPlaces.length, fmt: v => plural(v, 'new spot') },
      { icon: '📍', title: 'Spot Collector', val: s => s.places.length, fmt: v => plural(v, 'unique spot') },
      { icon: '📅', title: 'Most Days', val: s => s.days.length, fmt: v => plural(v, 'day') + ' studied' },
    ];
    const anyData = stats.some(s => s.count);
    el('leaderboard').innerHTML = `
      <div class="panel-head"><p class="eyebrow">LEADERBOARD // ${MONTHS[S.month].toUpperCase()}</p><h3>Friendly competition.</h3></div>
      ${anyData ? `<ul class="lb-list">${cats.map(c => {
        const ranked = stats.map(s => ({ p: s.person, v: c.val(s) })).sort((a, b) => b.v - a.v);
        const top = ranked[0].v, winners = ranked.filter(r => r.v === top && top > 0);
        return `<li class="lb-item"><span class="lb-icon">${c.icon}</span><div class="lb-body"><span class="lb-title">${c.title}</span>${winners.length ? `<b>${winners.map(w => esc(w.p)).join(' & ')}</b> <small>— ${esc(c.fmt(top))}</small>` : '<b>Up for grabs</b>'}<div class="lb-bars">${ranked.map(r => `<span style="--pill:${ACCENT[r.p]};--w:${top ? Math.max(4, r.v / top * 100) : 4}%" title="${esc(r.p)}: ${esc(c.fmt(r.v))}"><i></i><em>${esc(r.p)}</em></span>`).join('')}</div></div><span class="lb-sprites">${winners.slice(0, 1).map(w => spriteMarkup(w.p)).join('')}</span></li>`;
      }).join('')}</ul>` : `<div class="study-empty small"><h3>The crown is up for grabs.</h3><p>Nobody has logged a session for ${MONTHS[S.month]} yet. First one in wins Study Champion.</p></div>`}`;
  }

  function renderAchievements(st) {
    const earned = achievementsFor(st);
    el('achievements').innerHTML = `
      <div class="panel-head"><p class="eyebrow">ACHIEVEMENTS // ${esc(st.person.toUpperCase())}</p><h3>Badges earned.</h3></div>
      ${earned.length ? `<div class="badge-grid">${earned.map(b => `<div class="badge${b.isNew ? ' new' : ''}"><span class="badge-icon">${b.icon}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small>${b.isNew ? `<em>NEW IN ${MONTHS[st.m].toUpperCase()}</em>` : ''}</div>`).join('')}</div>` : `<div class="study-empty small"><h3>No badges yet.</h3><p>They unlock from real sessions: try an early start, a new spot, or a long one.</p></div>`}`;
  }

  // ---------------------------------------------------------------- timelapse engine
  const TL = {
    supported: !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && window.indexedDB),
    stream: null, video: null, timer: null, count: 0, interval: 3000, maxFrames: 600, facing: 'user', state: 'off', error: '',
  };
  function idb() {
    return TL.dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('study-timelapse', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('frames', { keyPath: 'k' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function frameTx(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('frames', mode); const out = fn(tx.objectStore('frames')); tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); }); }
  async function frameKeys(id) {
    const db = await idb();
    return new Promise((res, rej) => { const r = db.transaction('frames').objectStore('frames').getAllKeys(IDBKeyRange.bound(id + ':', id + ':\uffff')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function getFrame(k) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction('frames').objectStore('frames').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function clearFrames(id) { const keys = await frameKeys(id); await frameTx('readwrite', st => keys.forEach(k => st.delete(k))); }

  async function startCamera() {
    if (!TL.supported) { TL.state = 'unsupported'; return false; }
    try {
      stopCamera();
      TL.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: TL.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      TL.video = document.createElement('video');
      TL.video.muted = true; TL.video.playsInline = true; TL.video.srcObject = TL.stream;
      await TL.video.play();
      TL.state = 'recording'; TL.error = '';
      const prev = el('livePreview'); if (prev) { prev.srcObject = TL.stream; prev.play().catch(() => {}); }
      return true;
    } catch (e) {
      TL.state = 'blocked'; TL.error = e && e.name === 'NotAllowedError' ? 'Camera permission was blocked' : 'Camera unavailable';
      return false;
    }
  }
  function stopCamera() { TL.stream?.getTracks().forEach(t => t.stop()); TL.stream = null; TL.video = null; }

  async function beginCapture(active) {
    const keys = await frameKeys(active.id).catch(() => []);
    TL.count = keys.length;
    TL.interval = active.tlInterval || 3000;
    clearInterval(TL.timer);
    TL.timer = setInterval(() => captureFrame(active).catch(() => {}), TL.interval);
    captureFrame(active).catch(() => {});
  }
  async function captureFrame(active) {
    const v = TL.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
    const c = TL.canvas ||= document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, w, h);   // saved unmirrored so text in the shot reads normally
    // camcorder-style date stamp
    const stamp = `${active.place.toUpperCase()}  ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    g.font = `600 ${Math.round(h / 22)}px "DM Mono", monospace`;
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillText(stamp, 15, h - 13);
    g.fillStyle = '#ffd88a'; g.fillText(stamp, 14, h - 14);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    if (!blob) return;
    const k = `${active.id}:${String(Date.now()).padStart(15, '0')}`;
    await frameTx('readwrite', st => st.put({ k, blob }));
    TL.count++;
    if (TL.count >= TL.maxFrames) await thinFrames(active);
    updateLiveStatus();
  }
  async function thinFrames(active) {
    const keys = await frameKeys(active.id);
    await frameTx('readwrite', st => keys.forEach((k, i) => { if (i % 2) st.delete(k); }));
    TL.count = Math.ceil(keys.length / 2);
    TL.interval *= 2; active.tlInterval = TL.interval; store('studyActive', active);
    clearInterval(TL.timer);
    TL.timer = setInterval(() => captureFrame(active).catch(() => {}), TL.interval);
  }

  function pickMime() {
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  }
  async function renderTimelapse(id, onProgress) {
    const keys = await frameKeys(id);
    if (keys.length < 2) return null;
    const firstFrame = await createImageBitmap((await getFrame(keys[0])).blob);
    const c = document.createElement('canvas');
    c.width = firstFrame.width; c.height = firstFrame.height;
    const g = c.getContext('2d');
    g.drawImage(firstFrame, 0, 0);
    const fps = Math.max(8, Math.min(30, Math.ceil(keys.length / 20)));
    const mime = pickMime();
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    for (let i = 0; i < keys.length; i++) {
      const f = await getFrame(keys[i]);
      const bmp = await createImageBitmap(f.blob);
      g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      onProgress?.((i + 1) / keys.length);
      await new Promise(r => setTimeout(r, 1000 / fps));
    }
    await new Promise(r => setTimeout(r, 300));
    rec.stop(); await done;
    stream.getTracks().forEach(t => t.stop());
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    return new Blob(chunks, { type });
  }
  async function uploadVideo(blob, id) {
    const fd = new FormData();
    fd.append('upload_preset', CLOUDINARY.preset);
    fd.append('folder', `${CLOUDINARY.folder}/timelapses`);
    fd.append('tags', 'spot-rankings,timelapse');
    fd.append('file', blob, `${id}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY.cloud}/video/upload`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.secure_url) throw new Error(data?.error?.message || `Video upload failed (${res.status})`);
    return data.secure_url.replace('/video/upload/', '/video/upload/f_auto,q_auto/');
  }

  // wake lock keeps phones from sleeping mid-session
  let wakeLock = null;
  async function holdWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (S.active && document.visibilityState === 'visible') { holdWake(); if (S.active.timelapse && !TL.stream) resumeCamera(); } });

  // ---------------------------------------------------------------- live session
  let liveTick = null;
  async function startStudying({ person, place, area, studied, timelapse }) {
    const now = new Date();
    const active = { id: newId(), person, place, area, studied: studied || '', date: ymd(now), start: hhmm(now), startedAt: now.toISOString(), startMs: now.getTime(), timelapse: !!timelapse && TL.supported };
    S.active = active; store('studyActive', active);
    store(`studyLastPlace:${person}`, { place, area });
    S.person = person; store('studyPerson', person);
    renderStudy();
    saveSession({ id: active.id, place, area, date: active.date, start: active.start, end: '', minutes: '', status: 'active', studied: active.studied, rating: '', notes: '', photos: [], timelapse: '', source: 'live', startedAt: active.startedAt, person }).catch(() => {});
    holdWake();
    if (active.timelapse) { if (await startCamera()) beginCapture(active); }
    startTicking();
    updateLiveStatus();
  }
  async function resumeCamera() {
    if (!S.active?.timelapse) return;
    if (await startCamera()) beginCapture(S.active);
    updateLiveStatus();
  }
  function startTicking() {
    clearInterval(liveTick);
    const tick = () => {
      if (!S.active) return;
      const t = fmtClock((Date.now() - S.active.startMs) / 1000);
      const clock = el('liveClock'); if (clock) clock.textContent = t;
      const pill = el('liveNavPill'); if (pill) pill.querySelector('b').textContent = t;
    };
    tick(); liveTick = setInterval(tick, 1000);
  }

  function renderLive() {
    const box = el('liveSession'), pill = el('liveNavPill');
    if (!S.active) { box.classList.add('hidden'); box.innerHTML = ''; pill?.classList.add('hidden'); return; }
    const a = S.active;
    pill?.classList.remove('hidden');
    box.classList.remove('hidden');
    box.style.setProperty('--accent', ACCENT[a.person]);
    box.innerHTML = `
      <div class="live-main">
        <p class="eyebrow">CURRENTLY STUDYING // ${esc(a.person.toUpperCase())}</p>
        <h2>📚 Studying at <em>${esc(a.place)}</em></h2>
        <div class="live-clock" id="liveClock" aria-live="off">${fmtClock((Date.now() - a.startMs) / 1000)}</div>
        <p class="live-meta">Started at ${esc(time12(a.start))}${a.studied ? ` · ${esc(a.studied)}` : ''}</p>
        <p class="live-tl" id="liveTlStatus"></p>
        <div class="live-actions"><button type="button" class="study-btn stop" id="stopStudyBtn">■ Stop Study Session</button>${a.timelapse ? '<button type="button" class="study-btn ghost" id="flipCamBtn">⟲ Flip camera</button>' : ''}</div>
      </div>
      ${a.timelapse ? `<div class="live-cam${TL.facing === 'user' ? ' mirror' : ''}"><video id="livePreview" muted playsinline autoplay></video><span class="rec-dot">REC</span></div>` : ''}`;
    if (TL.stream) { const v = el('livePreview'); v.srcObject = TL.stream; v.play().catch(() => {}); }
    updateLiveStatus();
  }
  function updateLiveStatus() {
    const s = el('liveTlStatus'); if (!s || !S.active) return;
    const a = S.active;
    if (!a.timelapse) { s.innerHTML = TL.supported ? 'Timelapse ○ off' : 'Timelapse ○ not supported in this browser'; return; }
    if (TL.state === 'recording' && TL.stream) s.innerHTML = `Timelapse <span class="rec">●</span> Recording · ${plural(TL.count, 'frame')} · keep this tab open`;
    else if (TL.state === 'blocked') s.innerHTML = `Timelapse ○ ${esc(TL.error)} — <button type="button" class="link-btn" id="resumeCamBtn">try again</button> (your timer keeps running)`;
    else s.innerHTML = `Timelapse ○ Paused · ${plural(TL.count, 'frame')} saved — <button type="button" class="link-btn" id="resumeCamBtn">resume camera</button>`;
  }

  async function stopStudying() {
    const a = S.active; if (!a) return;
    const end = new Date();
    clearInterval(TL.timer); clearInterval(liveTick);
    if (a.timelapse && TL.video) await captureFrame(a).catch(() => {});
    stopCamera(); TL.state = 'off';
    try { await wakeLock?.release(); } catch (_) {}
    const minutes = Math.max(1, Math.round((end.getTime() - a.startMs) / 60000));
    const rec = { id: a.id, person: a.person, place: a.place, area: a.area, date: a.date, start: a.start, end: hhmm(end), minutes, status: 'done', studied: a.studied, rating: '', notes: '', photos: [], timelapse: '', source: 'live', startedAt: a.startedAt };
    S.active = null; store('studyActive', undefined);
    const pending = load('studyPendingTimelapses', []);
    if (a.timelapse) store('studyPendingTimelapses', [...new Set([...pending, a.id])]);
    saveSession(rec).catch(() => {});
    renderStudy();
    openWrapUp(rec, a.timelapse);
  }

  // ---------------------------------------------------------------- modal: log / start / wrap-up
  const modal = () => el('studyModal');
  function openModal(html) {
    modal().querySelector('.study-modal-body').innerHTML = html;
    modal().classList.remove('hidden');
    document.body.classList.add('no-scroll');
    modal().querySelector('input,select,button:not(.close)')?.focus();
  }
  function closeModal() {
    modal().classList.add('hidden');
    document.body.classList.remove('no-scroll');
    modal().querySelectorAll('video').forEach(v => v.pause());
    picker.reset();
  }

  function locationOptions(person, selected) {
    const groups = {};
    allSpots().forEach(s => { (groups[s.area] ||= []).push(s.name); });
    const known = new Set(allSpots().map(s => `${s.area}|${s.name}`));
    const mine = groupPlaces(doneSessions(person)).filter(p => !known.has(placeKey(p)));
    const opt = (area, name) => { const v = `${area}|${name}`; return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(name)}</option>`; };
    return `<option value="">Pick a spot…</option>${Object.entries(groups).map(([area, names]) => `<optgroup label="${esc(area === 'On Campus' ? 'USC Campus' : area)}">${names.sort((a, b) => a.localeCompare(b)).map(n => opt(area, n)).join('')}</optgroup>`).join('')}${mine.length ? `<optgroup label="Your other places">${mine.map(p => opt(p.area, p.place)).join('')}</optgroup>` : ''}<option value="__new">＋ Somewhere new…</option>`;
  }
  function starsHTML(name, value = 0) {
    return `<div class="star-input" role="radiogroup" aria-label="Rating">${[5, 4, 3, 2, 1].map(n => `<input type="radio" id="${name}-${n}" name="${name}" value="${n}"${n === value ? ' checked' : ''}><label for="${name}-${n}" title="${n} star${n > 1 ? 's' : ''}">★</label>`).join('')}</div>`;
  }
  function personPills(selected) {
    return `<div class="pill-row" role="radiogroup" aria-label="Who is studying">${REVIEWERS.map(p => `<label class="person-pill radio" style="--pill:${ACCENT[p]}"><input type="radio" name="person" value="${esc(p)}"${p === selected ? ' checked' : ''}><span class="pill-sprite">${spriteMarkup(p)}</span>${esc(p)}</label>`).join('')}</div>`;
  }
  const photoField = () => `<div class="form-field full"><label>Photos (optional)</label><label class="photo-drop small">ADD PHOTOS<input type="file" id="sessionPhotos" accept="image/*,.heic,.heif,image/heic,image/heif" multiple><span>desk · view · snacks</span></label><div class="photo-preview" id="sessionPhotoPreview"></div></div>`;

  function openLogModal({ mode = 'start', date } = {}) {
    if (S.active && mode === 'start') mode = 'past';
    const person = S.person, last = load(`studyLastPlace:${person}`, null);
    const sel = last ? `${last.area}|${last.place}` : '';
    const now = new Date();
    openModal(`
      <p class="eyebrow">LOG_SESSION.EXE</p>
      <h2 id="studyModalTitle">Log a study session</h2>
      <div class="seg" role="tablist">
        <button type="button" role="tab" class="seg-btn${mode === 'start' ? ' active' : ''}" data-mode="start" ${S.active ? 'disabled title="A session is already running"' : ''}>▶ Start now</button>
        <button type="button" role="tab" class="seg-btn${mode === 'past' ? ' active' : ''}" data-mode="past">✎ Already studied</button>
      </div>
      <form id="sessionForm" data-mode="${mode}" novalidate>
        <div class="form-field full"><label>Who's studying?</label>${personPills(person)}</div>
        <div class="form-field full"><label for="sessionPlace">Where?</label><select id="sessionPlace" name="place" required>${locationOptions(person, sel)}</select></div>
        <div class="form-grid new-loc hidden"><div class="form-field"><label for="newLocName">New spot name</label><input id="newLocName" name="newPlace" placeholder="e.g. Doheny steps"></div><div class="form-field"><label for="newLocArea">Area</label><select id="newLocArea" name="newArea"><option value="On Campus">USC Campus</option><option value="K-Town">K-Town</option><option value="Fryft Zone">Fryft Zone</option><option value="Other">Somewhere else</option></select></div></div>
        <div class="form-field full"><label for="sessionStudied">What are you studying? <small>(optional)</small></label><input id="sessionStudied" name="studied" maxlength="200" placeholder="e.g. CSCI 104 midterm"></div>
        <div class="mode-start">
          <label class="toggle"><input type="checkbox" name="timelapse" ${TL.supported ? 'checked' : 'disabled'}><span></span>Record a timelapse <small>${TL.supported ? 'uses your camera · keep this tab open' : 'not supported in this browser'}</small></label>
          <button class="submit-rating study-submit" type="submit">▶ START STUDYING</button>
        </div>
        <div class="mode-past">
          <div class="form-grid">
            <div class="form-field"><label for="sessionDate">Date</label><input type="date" id="sessionDate" name="date" value="${date || ymd(now)}" max="${ymd(now)}"></div>
            <div class="form-field"><label for="sessionStart">Start time</label><input type="time" id="sessionStart" name="start" value="${pad2(Math.max(0, now.getHours() - 2))}:00"></div>
            <div class="form-field full"><label>Ended…</label><div class="seg small"><button type="button" class="seg-btn active" data-end="time">at a time</button><button type="button" class="seg-btn" data-end="dur">after a duration</button></div></div>
            <div class="form-field end-time"><label for="sessionEnd">End time</label><input type="time" id="sessionEnd" name="end" value="${hhmm(now).slice(0, 2)}:00"></div>
            <div class="form-field end-dur hidden"><label>Duration</label><div class="dur-row"><input type="number" name="durH" min="0" max="23" value="2" aria-label="Hours"><span>h</span><input type="number" name="durM" min="0" max="59" step="5" value="0" aria-label="Minutes"><span>m</span></div></div>
          </div>
          <div class="form-field full"><label>How was it?</label>${starsHTML('rating')}</div>
          <div class="form-field full"><label for="sessionNotes">Notes</label><textarea id="sessionNotes" name="notes" maxlength="1000" placeholder="Outlets? Crowd? Best seat?"></textarea></div>
          ${photoField()}
          <div class="form-field full"><label>Timelapse video <small>(optional — e.g. one you filmed on your phone)</small></label><input type="file" id="sessionVideo" accept="video/*"></div>
          <button class="submit-rating study-submit" type="submit">SAVE SESSION →</button>
        </div>
        <div class="form-status" id="sessionStatus" role="status"></div>
      </form>`);
    picker.bind('sessionPhotos', 'sessionPhotoPreview');
    syncNewLoc();
  }

  function openWrapUp(rec, hasTimelapse) {
    openModal(`
      <p class="eyebrow">SESSION_COMPLETE.EXE</p>
      <h2 id="studyModalTitle">Nice work, ${esc(rec.person)}.</h2>
      <p class="wrapup-sum"><b>${fmtDur(rec.minutes)}</b> at ${esc(rec.place)} · ${esc(time12(rec.start))} – ${esc(time12(rec.end))}</p>
      ${hasTimelapse ? '<div class="wrapup-tl" id="wrapupTl"><div class="tl-progress"><i id="tlBar"></i></div><p id="tlMsg">Rendering your timelapse…</p></div>' : ''}
      <form id="wrapupForm" data-id="${esc(rec.id)}" novalidate>
        <div class="form-field full"><label for="wrapStudied">What did you study?</label><input id="wrapStudied" name="studied" maxlength="200" value="${esc(rec.studied || '')}" placeholder="e.g. Orgo problem set"></div>
        <div class="form-field full"><label>Rate this session</label>${starsHTML('rating')}</div>
        <div class="form-field full"><label for="wrapNotes">Notes</label><textarea id="wrapNotes" name="notes" maxlength="1000" placeholder="How was the spot today?"></textarea></div>
        ${photoField()}
        <p class="form-note">Want to update your full spot rating too? <button type="button" class="link-btn" data-rate-place='${esc(JSON.stringify({ person: rec.person, area: rec.area, place: rec.place, date: rec.date }))}'>Rate ${esc(rec.place)} →</button></p>
        <div class="wrapup-actions"><button class="submit-rating study-submit" type="submit">SAVE SESSION →</button><button type="button" class="study-btn ghost" id="skipWrapup">Skip details</button></div>
        <div class="form-status" id="sessionStatus" role="status">Session saved to your calendar. Add details if you like.</div>
      </form>`);
    picker.bind('sessionPhotos', 'sessionPhotoPreview');
    if (hasTimelapse) processTimelapse(rec.id);
  }

  // render + upload a timelapse, then attach it to the session
  const tlJobs = {};
  function processTimelapse(id) {
    return tlJobs[id] ||= (async () => {
      const bar = () => el('tlBar'), msg = t => { const m = el('tlMsg'); if (m) m.innerHTML = t; };
      try {
        const blob = await renderTimelapse(id, p => { if (bar()) bar().style.width = `${Math.round(p * 100)}%`; });
        if (!blob) { msg('Not enough camera frames for a timelapse this time.'); await clearFrames(id); dropPending(id); return; }
        const preview = URL.createObjectURL(blob);
        const box = el('wrapupTl');
        if (box && modal().querySelector(`#wrapupForm[data-id="${id}"]`)) box.insertAdjacentHTML('afterbegin', `<video class="tl-preview" src="${preview}" controls playsinline loop muted autoplay></video>`);
        if (!(S.localRecs[id] || allSessions().find(s => s.id === id))) throw new Error('session not loaded yet');
        msg('Uploading timelapse…');
        const url = await uploadVideo(blob, id);
        const base = S.localRecs[id] || allSessions().find(s => s.id === id);
        if (!base) throw new Error('session not loaded yet');
        await saveSession({ ...base, timelapse: url });
        await clearFrames(id); dropPending(id);
        msg('Timelapse saved ✓ — find it in your calendar and Wrapped.');
        renderStudy();
      } catch (e) {
        console.error(e);
        msg(`Timelapse not uploaded: ${esc(e.message)}. It's kept on this device — <button type="button" class="link-btn" data-retry-tl="${esc(id)}">try again</button>`);
        delete tlJobs[id];
      }
    })();
  }
  function dropPending(id) { store('studyPendingTimelapses', load('studyPendingTimelapses', []).filter(x => x !== id)); }

  // simple photo picker (HEIC-aware, removable thumbnails)
  const picker = {
    files: [], seq: 0,
    reset() { this.files.forEach(f => URL.revokeObjectURL(f.url)); this.files = []; },
    bind(inputId, previewId) {
      this.reset();
      const input = el(inputId), preview = el(previewId);
      if (!input) return;
      input.addEventListener('change', async () => {
        const list = [...input.files]; input.value = '';
        for (let f of list) {
          if (typeof isHeic === 'function' && isHeic(f)) { try { f = await heicToJpeg(f); } catch (_) {} }
          this.files.push({ id: ++this.seq, file: f, url: URL.createObjectURL(f) });
          this.draw(preview);
        }
      });
      preview.addEventListener('click', e => { const b = e.target.closest('.photo-remove'); if (!b) return; this.files = this.files.filter(x => x.id !== Number(b.dataset.id)); this.draw(preview); });
    },
    draw(preview) { preview.innerHTML = this.files.map(p => `<figure class="photo-thumb"><img src="${p.url}" alt=""><button type="button" class="photo-remove" data-id="${p.id}" aria-label="Remove photo">×</button></figure>`).join(''); },
    async upload(status) {
      const urls = [];
      for (let i = 0; i < this.files.length; i++) {
        status(`Uploading photo ${i + 1} of ${this.files.length}…`);
        let file = this.files[i].file;
        try { file = await compressPhoto(file); } catch (_) {}
        urls.push((await uploadToCloudinary(file, 'session')).url);
      }
      return urls;
    },
  };

  function readPlace(form) {
    const v = form.querySelector('#sessionPlace').value;
    if (v === '__new') { const place = form.newPlace.value.trim(); return place ? { place, area: form.newArea.value } : null; }
    if (!v) return null;
    const i = v.indexOf('|'); return { area: v.slice(0, i), place: v.slice(i + 1) };
  }
  function syncNewLoc() {
    const sel = el('sessionPlace'); if (!sel) return;
    modal().querySelector('.new-loc')?.classList.toggle('hidden', sel.value !== '__new');
  }
  function setStatus(text, kind = '') { const s = el('sessionStatus'); if (s) { s.textContent = text; s.className = `form-status ${kind}`; } }

  async function submitSessionForm(form) {
    const person = form.person.value, loc = readPlace(form);
    if (!loc) { setStatus(form.querySelector('#sessionPlace').value === '__new' ? 'Name the new spot first.' : 'Pick where you studied.', 'error'); return; }
    if (form.dataset.mode === 'start') {
      closeModal();
      await startStudying({ person, ...loc, studied: form.studied.value.trim(), timelapse: form.timelapse.checked });
      return;
    }
    const date = form.date.value, start = form.start.value;
    if (!date || date > ymd(new Date())) { setStatus('Pick a date (today or earlier).', 'error'); return; }
    if (!start) { setStatus('Add a start time.', 'error'); return; }
    let end, minutes;
    if (!form.querySelector('.end-dur').classList.contains('hidden')) {
      minutes = (Number(form.durH.value) || 0) * 60 + (Number(form.durM.value) || 0);
      end = hhmm(new Date(parseYMD(date).setHours(0, toMin(start) + minutes)));
    } else {
      end = form.end.value; if (!end) { setStatus('Add an end time or switch to a duration.', 'error'); return; }
      minutes = minutesBetween(start, end);
    }
    if (minutes < 1 || minutes > 24 * 60) { setStatus('That session length looks off — check the times.', 'error'); return; }
    const btn = form.querySelector('.mode-past .study-submit'); btn.disabled = true;
    try {
      const photos = await picker.upload(t => setStatus(t));
      let timelapse = '';
      const video = form.querySelector('#sessionVideo').files[0];
      const id = newId();
      if (video) { setStatus('Uploading timelapse video…'); timelapse = await uploadVideo(video, id); }
      setStatus('Saving session…');
      const rating = Number(form.querySelector('input[name="rating"]:checked')?.value) || '';
      await saveSession({ id, person, ...loc, date, start, end, minutes, status: 'done', studied: form.studied.value.trim(), rating, notes: form.notes.value.trim(), photos, timelapse, source: 'manual', startedAt: '' });
      store(`studyLastPlace:${person}`, loc);
      S.person = person; store('studyPerson', person);
      const d = parseYMD(date); S.year = d.getFullYear(); S.month = d.getMonth();
      closeModal(); renderStudy(); refreshSoon();
    } catch (e) {
      setStatus(`Not saved: ${e.message}`, 'error');
    } finally { btn.disabled = false; }
  }

  async function submitWrapUp(form, skip) {
    const id = form.dataset.id;
    const latest = () => S.localRecs[id] || allSessions().find(s => s.id === id);
    const rec = { ...latest() };
    const btn = form.querySelector('.study-submit'); btn.disabled = true;
    try {
      if (!skip) {
        const details = { studied: form.studied.value.trim(), notes: form.notes.value.trim(), rating: Number(form.querySelector('input[name="rating"]:checked')?.value) || '' };
        const newPhotos = await picker.upload(t => setStatus(t));
        const now = latest();
        setStatus('Saving…');
        await saveSession({ ...now, ...details, photos: [...(now.photos || []), ...newPhotos] });
      }
      const d = parseYMD(rec.date); S.year = d.getFullYear(); S.month = d.getMonth(); S.person = rec.person;
      closeModal(); renderStudy(); refreshSoon();
    } catch (e) { setStatus(`Not saved: ${e.message}`, 'error'); }
    finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- events
  function bind() {
    const view = el('studyView');
    el('startStudyBtn').addEventListener('click', () => openLogModal({ mode: 'start' }));
    el('logSessionBtn').addEventListener('click', () => openLogModal({ mode: 'past' }));
    el('prevMonth').addEventListener('click', () => { if (--S.month < 0) { S.month = 11; S.year--; } S.deckIndex = 0; renderStudy(); });
    el('nextMonth').addEventListener('click', () => { if (++S.month > 11) { S.month = 0; S.year++; } S.deckIndex = 0; renderStudy(); });
    el('liveNavPill')?.addEventListener('click', () => { document.querySelector('.nav-link[data-view="study"]')?.click(); });

    view.addEventListener('click', e => {
      const t = e.target;
      const pill = t.closest('#studyPersonPicker .person-pill');
      if (pill) { S.person = pill.dataset.person; store('studyPerson', S.person); S.deckIndex = 0; renderStudy(); return; }
      if (t.closest('.deck-nav.next')) return goDeck(1);
      if (t.closest('.deck-nav.prev')) return goDeck(-1);
      const card = t.closest('.wrap-card.active');
      if (card && !t.closest('video,button,a')) { const r = card.getBoundingClientRect(); goDeck(e.clientX - r.left < r.width * 0.3 ? -1 : 1); return; }
      const day = t.closest('.cal-day'); if (day && !day.disabled) return openDay(day.dataset.date);
      if (t.closest('#stopStudyBtn')) return stopStudying();
      if (t.closest('#resumeCamBtn')) return resumeCamera();
      if (t.closest('#flipCamBtn')) { TL.facing = TL.facing === 'user' ? 'environment' : 'user'; el('liveSession').querySelector('.live-cam')?.classList.toggle('mirror', TL.facing === 'user'); return resumeCamera(); }
    });
    view.addEventListener('keydown', e => {
      if (!e.target.closest('.deck-stage')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); goDeck(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goDeck(-1); }
    });
    let touchX = null;
    view.addEventListener('touchstart', e => { if (e.target.closest('.deck-stage')) touchX = e.touches[0].clientX; }, { passive: true });
    view.addEventListener('touchend', e => { if (touchX == null) return; const dx = e.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(dx) > 40) goDeck(dx < 0 ? 1 : -1); });

    // drawer
    const drawer = el('dayDrawer');
    drawer.addEventListener('click', async e => {
      const t = e.target;
      if (t === drawer || t.closest('.drawer-close')) return closeDrawer();
      const nav = t.closest('[data-viewer]'); if (nav) { viewer.i = (viewer.i + Number(nav.dataset.viewer) + viewer.photos.length) % viewer.photos.length; return updateViewer(); }
      const go = t.closest('[data-viewer-go]'); if (go) { viewer.i = Number(go.dataset.viewerGo); return updateViewer(); }
      const logFor = t.closest('[data-log-for]'); if (logFor) { closeDrawer(); return openLogModal({ mode: 'past', date: logFor.dataset.logFor }); }
      const rate = t.closest('[data-rate-session]');
      if (rate) { const s = allSessions().find(x => x.id === rate.dataset.rateSession); closeDrawer(); return openRatingFor({ person: s.person, area: s.area, place: s.place, date: s.date }); }
      const del = t.closest('[data-delete-session]');
      if (del) {
        if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.textContent = 'Delete'; } }, 4000); return; }
        const s = allSessions().find(x => x.id === del.dataset.deleteSession);
        del.disabled = true; del.textContent = 'Deleting…';
        try { await deleteSession(s); const date = s.date; renderStudy(); openDay(date); } catch (err) { del.textContent = `Couldn't delete: ${err.message}`; }
      }
    });

    // modal
    const m = modal();
    m.addEventListener('click', e => {
      const t = e.target;
      if (t === m || t.closest('.close')) { const wrap = m.querySelector('#wrapupForm'); if (wrap) submitWrapUp(wrap, true); else closeModal(); return; }
      const seg = t.closest('.seg-btn[data-mode]');
      if (seg && !seg.disabled) { m.querySelectorAll('.seg-btn[data-mode]').forEach(b => b.classList.toggle('active', b === seg)); el('sessionForm').dataset.mode = seg.dataset.mode; return; }
      const endSeg = t.closest('.seg-btn[data-end]');
      if (endSeg) { m.querySelectorAll('.seg-btn[data-end]').forEach(b => b.classList.toggle('active', b === endSeg)); m.querySelector('.end-time').classList.toggle('hidden', endSeg.dataset.end !== 'time'); m.querySelector('.end-dur').classList.toggle('hidden', endSeg.dataset.end !== 'dur'); return; }
      if (t.closest('#skipWrapup')) return submitWrapUp(el('wrapupForm'), true);
      const retry = t.closest('[data-retry-tl]'); if (retry) return processTimelapse(retry.dataset.retryTl);
      const rp = t.closest('[data-rate-place]');
      if (rp) { const info = JSON.parse(rp.dataset.ratePlace); const wrap = el('wrapupForm'); (wrap ? submitWrapUp(wrap, false) : Promise.resolve()).then(() => openRatingFor(info)); }
    });
    m.addEventListener('change', e => {
      if (e.target.id === 'sessionPlace') syncNewLoc();
      if (e.target.name === 'person' && e.target.closest('#sessionForm')) {
        const last = load(`studyLastPlace:${e.target.value}`, null);
        el('sessionPlace').innerHTML = locationOptions(e.target.value, last ? `${last.area}|${last.place}` : '');
        syncNewLoc();
      }
    });
    m.addEventListener('submit', e => {
      e.preventDefault();
      if (e.target.id === 'sessionForm') submitSessionForm(e.target);
      if (e.target.id === 'wrapupForm') submitWrapUp(e.target, false);
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!el('dayDrawer').classList.contains('hidden')) closeDrawer();
      else if (!modal().classList.contains('hidden')) { const wrap = modal().querySelector('#wrapupForm'); if (wrap) submitWrapUp(wrap, true); else closeModal(); }
    });
    window.addEventListener('spots-loaded', () => { if (S.loaded) renderStudy(); });
    window.addEventListener('beforeunload', e => { if (S.active) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!el('studyView')) return;
    bind();
    renderStudy();
    if (S.active) {
      startTicking();
      if (S.active.timelapse) resumeCamera();
      holdWake();
    }
    flushOutbox().finally(() => loadStudyData().catch(e => { console.error(e); S.loaded = true; renderStudy(); }));
    // finish any timelapses that were recorded but never uploaded
    if (TL.supported) load('studyPendingTimelapses', []).forEach(id => { if (!S.active || S.active.id !== id) setTimeout(() => processTimelapse(id), 4000); });
    setInterval(() => { if (!document.hidden && !el('studyView').classList.contains('hidden')) loadStudyData().catch(() => {}); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.StudyWrapped = { statsFor, comparisons, achievementsFor, state: S, render: renderStudy };
})();
