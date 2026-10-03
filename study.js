/* Study Wrapped — study sessions, live timer + camera timelapse, monthly recap,
 * shared calendar, study diary, leaderboard and achievements.
 *
 * Data model (all in the existing Google Sheet, written through the Apps Script):
 *   User        = a rater (REVIEWERS in script.js)
 *   Location    = a spot from the On Campus / K-Town / Fryft Zone tabs (or a new place, area "Other")
 *   Sessions    tab: Session ID · Person · Place · Area · Date · Start · End · Minutes · Status · Studied ·
 *                    Rating · Notes · Timelapse · Source · Started At · Updated At
 *   Photos      tab (existing): session photos are rows with Photo Type "session" + Session ID
 *   Rating Log  tab: every spot rating with the date it applies to
 * Monthly statistics are always computed from these rows — nothing is stored as a running total.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const pad2 = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const parseYMD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const minutesBetween = (a, b) => { let d = toMin(b) - toMin(a); if (d < 0) d += 1440; return d; };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const CAFE_AREAS = ['K-Town', 'Fryft Zone'];
  const ACCENT = { Lena: '#7b1e2b', Ashlyn: '#b8862f', Marc: '#315d72' };
  const STALE_HOURS = 8;   // a live timer older than this asks "still studying?"
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const TAB_ID = Math.random().toString(36).slice(2);

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
  const crossesMidnight = s => s.start && s.end && toMin(s.end) < toMin(s.start);
  const timeRange = s => s.start ? `${time12(s.start)}${s.end ? ` – ${time12(s.end)}${crossesMidnight(s) ? ' (+1 day)' : ''}` : ''}` : '';
  function niceNum(n) { return n >= 10 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toString(); }
  function longDate(s) { return parseYMD(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function shortDate(s) { return parseYMD(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function newId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function store(key, val) { try { val === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
  function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
  function seeded(seedText) { let h = 2166136261; for (const c of seedText) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
  const placeKey = s => `${s.area}|${s.place}`;
  const isCafe = s => CAFE_AREAS.includes(s.area);
  const posterOf = url => (url.includes('/video/upload/f_auto,q_auto/') ? url.replace('/video/upload/f_auto,q_auto/', '/video/upload/so_0/') : url.replace('/video/upload/', '/video/upload/so_0/')).replace(/\.[a-z0-9]+$/i, '.jpg');
  const allSpots = () => (typeof spots !== 'undefined' && Array.isArray(spots) ? spots : []);
  const stars = n => `<span class="stars-read" aria-label="${n} of 5 stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;

  // ---------------------------------------------------------------- state
  const today = new Date();
  const S = {
    person: REVIEWERS.includes(load('studyPerson')) ? load('studyPerson') : REVIEWERS[0],
    calMode: load('studyCalMode', 'shared'),     // shared calendar by default
    year: today.getFullYear(),
    month: today.getMonth(),
    sheetSessions: [],
    localRecs: {},             // id -> latest record we sent (wins while the sheet catches up)
    deleted: new Set(),
    localPhotos: [],           // {sessionId,url} uploaded this visit
    removedPhotos: new Set(),
    ratingLog: [],
    loaded: false,
    deckIndex: 0,
    diaryAll: false,
    active: load('studyActive', null),   // the session timed on this device
  };
  let cache = null;
  const invalidate = () => { cache = null; };

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
      id: r[0], person: r[1], place: String(r[2] || '').trim() || 'Somewhere unlisted', area: String(r[3] || '').trim() || 'Other',
      date: r[4], start: r[5], end: r[6], minutes: Number(r[7]) || 0, status: r[8] === 'active' ? 'active' : 'done',
      studied: r[9] || '', rating: Number(r[10]) || null, notes: r[11] || '', timelapse: r[12] || '', source: r[13] || 'manual', startedAt: r[14] || '',
    };
  }

  async function loadStudyData() {
    const [sessRows, logRows] = await Promise.all([getTextTab('Sessions', 'Session ID'), getTextTab('Rating Log', 'Logged At')]);
    const seen = new Set();
    S.sheetSessions = sessRows.map(parseSession).filter(s => {
      if (!s.id || seen.has(s.id) || !REVIEWERS.includes(s.person) || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return false;
      seen.add(s.id); return true;     // duplicate IDs (e.g. a double submit) count once
    });
    S.ratingLog = logRows.map(r => ({ loggedAt: r[0], date: r[1], person: r[2], place: r[3], area: r[4], overall: r[5] === '' ? null : Number(r[5]), notes: r[6] || '' }))
      .filter(r => REVIEWERS.includes(r.person) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    // the sheet has caught up with anything older than two minutes
    for (const [id, rec] of Object.entries(S.localRecs)) if (Date.now() - (rec._at || 0) > 120000 && seen.has(id)) delete S.localRecs[id];
    S.loaded = true;
    invalidate();
    syncActiveFromSheet();
    renderStudy();
  }

  function photosOf(id) {
    const urls = (window.photoLog || []).filter(p => p.type === 'session' && p.sessionId === id).map(p => p.url);
    for (const p of S.localPhotos) if (p.sessionId === id && !urls.includes(p.url)) urls.push(p.url);
    return urls.filter(u => !S.removedPhotos.has(u));
  }
  function allSessions() {
    if (cache) return cache;
    const map = new Map(S.sheetSessions.map(s => [s.id, s]));
    for (const [id, rec] of Object.entries(S.localRecs)) map.set(id, { ...map.get(id), ...rec });
    cache = [...map.values()].filter(s => !S.deleted.has(s.id)).map(s => ({ ...s, photos: photosOf(s.id) }));
    return cache;
  }
  const findSession = id => allSessions().find(s => s.id === id);
  const doneSessions = person => allSessions().filter(s => s.status === 'done' && (!person || s.person === person))
    .sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  function activeSessions() {
    return allSessions().filter(s => s.status === 'active' && !(S.active && s.id === S.active.id));
  }
  const elapsedMin = s => Math.max(1, Math.round((Date.now() - Date.parse(s.startedAt || `${s.date}T${s.start || '00:00'}`)) / 60000));
  function spotPhotosBy(person) {
    return (window.photoLog || []).filter(p => p.type !== 'session' && p.date && (!person || p.person === person));
  }
  // if this device thinks a session is running but it was finished elsewhere, stop timing it
  function syncActiveFromSheet() {
    if (!S.active) return;
    const s = S.sheetSessions.find(x => x.id === S.active.id);
    if (s && s.status === 'done' && !S.localRecs[s.id]) { endLocalTiming(); S.active = null; store('studyActive', undefined); }
  }

  // ---------------------------------------------------------------- saving
  const sendQueue = {};
  function saveSession(rec) {
    const clean = { ...rec }; delete clean.photos; delete clean._at;
    S.localRecs[rec.id] = { ...clean, _at: Date.now() };
    invalidate();
    const payload = { action: 'session', person: rec.person, session: clean };
    sendQueue[rec.id] = (sendQueue[rec.id] || Promise.resolve()).catch(() => {}).then(async () => {
      try { await sendPayload(payload); removeFromOutbox(rec.id); }
      catch (e) {
        if (/reach/i.test(e.message)) { addToOutbox(payload); return; }   // offline: keep and retry
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
      S.localRecs[payload.session.id] = { ...payload.session, _at: Date.now() };
      try { await sendPayload(payload); removeFromOutbox(payload.session.id); } catch (_) { break; }
    }
    invalidate();
  }
  async function deleteSession(s) {
    await sendPayload({ action: 'deleteSession', person: s.person, id: s.id });
    S.deleted.add(s.id); delete S.localRecs[s.id];
    s.photos.forEach(u => S.removedPhotos.add(u));
    invalidate();
  }
  async function addSessionPhotos(rec, files, status) {
    for (let i = 0; i < files.length; i++) {
      status?.(`Uploading photo ${i + 1} of ${files.length}…`);
      let file = files[i];
      try { file = await compressPhoto(file); } catch (_) {}
      const up = await uploadToCloudinary(file, 'session');
      await sendPayload({ action: 'photo', person: rec.person, place: rec.place, category: rec.area, sessionId: rec.id, photo: { type: 'session', url: up.url, publicId: up.publicId } });
      S.localPhotos.push({ sessionId: rec.id, url: up.url });
      invalidate();
    }
  }
  async function removeSessionPhoto(rec, url) {
    await sendPayload({ action: 'deletePhoto', person: rec.person, sessionId: rec.id, url });
    S.removedPhotos.add(url); invalidate();
  }
  function refreshSoon() { setTimeout(() => loadStudyData().catch(() => {}), 4000); }

  // a likely double entry: same person + date with overlapping time
  function findDuplicate({ person, date, start, minutes, place, area }, ignoreId) {
    const a0 = toMin(start), a1 = a0 + minutes;
    return doneSessions(person).find(s => {
      if (s.id === ignoreId || s.date !== date || !s.start) return false;
      const b0 = toMin(s.start), b1 = b0 + s.minutes, overlap = Math.min(a1, b1) - Math.max(a0, b0);
      return overlap > 0 && (overlap >= Math.min(minutes, s.minutes) * 0.5 || (s.place === place && s.area === area));
    });
  }

  // ---------------------------------------------------------------- stats (always derived from sessions)
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
    const daysSoFar = isCurrent ? now.getDate() : dim;
    const periodDays = isCurrent ? Math.max(7, now.getDate()) : dim;   // at least a week so day 2 doesn't extrapolate wildly
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

    // favourite: average of this month's ratings (session ★ x2 and 0–10 spot ratings)
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

    return {
      person, y, m, key, dim, isCurrent, daysSoFar, sessions: ms, all, total, count: ms.length, places, newPlaces, days,
      avgSession: ms.length ? total / ms.length : 0, weekly: periodDays ? total / (periodDays / 7) : 0, longest, streak,
      photos, timelapses, ratings, favorite, favoriteSource, mostRated: rateCounts[0] || null,
      ratingAvg: avgRating(ratings), prevRatingAvg: avgRating(S.ratingLog.filter(r => r.person === person && r.date.startsWith(prevKey))),
      cafes: places.filter(isCafe), campus: places.filter(p => p.area === 'On Campus'),
    };
  }

  // ---------------------------------------------------------------- fun comparisons (generated from the numbers)
  const UNITS = [
    { min: 120, many: 'movies', say: n => `about the length of ${n}` },
    { min: 22, many: 'sitcom episodes', say: n => `roughly ${n} back to back` },
    { min: 205, many: 'Eras Tour shows', say: n => `the same as sitting through ${n}` },
    { min: 380, many: 'drives from LA to San Francisco', say: n => `long enough for ${n}` },
    { min: 690, many: 'flights from LAX to Tokyo', say: n => `that's ${n}` },
    { min: 686, many: 'Lord of the Rings extended marathons', say: n => `enough for ${n}` },
    { min: 3.5, many: 'songs', say: n => `that's ${n} on repeat` },
    { min: 80, many: 'USC lectures', say: n => `about ${n} (but you chose these)` },
    { min: 210, many: 'Trojans football games', say: n => `the length of ${n}` },
    { min: 45, many: 'podcast episodes', say: n => `${n} worth of listening` },
  ];
  function pickUnits(minutes, count, seed) {
    const rnd = seeded(seed);
    return UNITS.filter(u => { const n = minutes / u.min; return n >= 1.5 && n <= 120; })
      .map(u => ({ u, r: rnd() })).sort((a, b) => a.r - b.r).slice(0, count)
      .map(({ u }) => u.say(`${niceNum(minutes / u.min)} ${u.many}`));
  }
  function comparisons(st) {
    if (!st.count) return [];
    const seed = `${st.person}-${st.key}`;
    const lines = [];
    const [a, b] = pickUnits(st.total, 2, seed);
    lines.push(a ? `You studied for ${fmtDur(st.total)} this month — ${a}.` : `You studied for ${fmtDur(st.total)} this month. Every minute counts.`);
    if (st.total >= 1440) lines.push(`${fmtDur(st.total)} is ${niceNum(st.total / 1440)} full days of studying. Sleep is also allowed.`);
    if (b) lines.push(`Put another way: ${b}.`);
    const [w] = pickUnits(st.weekly, 1, seed + 'w');
    if (w && st.weekly > 0) lines.push(`You averaged ${fmtDur(st.weekly)} a week — ${w}, every single week.`);
    if (st.places.length >= 5) lines.push(`You visited ${st.places.length} different study spots — that's basically a study-tour itinerary.`);
    else if (st.places.length >= 2) lines.push(`${st.places.length} different study spots this month. A tasteful rotation.`);
    else if (st.places.length === 1) lines.push(`Every session at ${st.places[0].place}. Loyalty like that deserves a punch card.`);
    if (st.cafes.length >= 2) lines.push(`You studied at ${st.cafes.length} different cafés this month — barista recognition: likely.`);
    if (st.campus.length && st.places.every(p => p.area === 'On Campus')) lines.push('Every session was on campus. Trojan to the core.');
    if (st.longest && st.longest.minutes >= 180) lines.push(`Your longest session (${fmtDur(st.longest.minutes)}) outlasted a three-hour movie. Respect.`);
    if (st.streak.best >= 3) lines.push(`A ${st.streak.best}-day streak. Your study spot started saving you a seat.`);
    if (st.count <= 2) lines.push('A quiet month — every streak starts with one session.');
    return lines;
  }

  // ---------------------------------------------------------------- achievements (earned from real sessions only)
  function weekendKey(d) { const x = parseYMD(d); if (x.getDay() === 0) x.setDate(x.getDate() - 1); return ymd(x); }
  const BADGES = [
    { id: 'regular', icon: '☕', name: 'The Regular', test: st => { const p = groupPlaces(st.list)[0]; return p && p.count >= 10 ? `Studied at ${p.place} ${p.count} times` : null; } },
    { id: 'tourist', icon: '🧳', name: 'Study Tourist', test: st => { const n = groupPlaces(st.list).length; return n >= 5 ? `Explored ${n} different study spots` : null; } },
    { id: 'explorer', icon: '🧭', name: 'Explorer', monthOnly: true, test: st => st.month.newPlaces.length ? `Found ${plural(st.month.newPlaces.length, 'new spot')} this month` : null },
    { id: 'early', icon: '🌅', name: 'Early Bird', test: st => { const n = st.list.filter(s => s.start && toMin(s.start) < 8 * 60).length; return n >= 3 ? `${n} sessions started before 8 AM` : null; } },
    { id: 'owl', icon: '🦉', name: 'Night Owl', test: st => { const n = st.list.filter(s => s.end && (toMin(s.end) >= 23 * 60 || crossesMidnight(s))).length; return n >= 3 ? `${n} sessions that ran past 11 PM` : null; } },
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
    renderCalendar();
    renderLeaderboard();
    renderDiary(st);
    renderAchievements(st);
  }

  function renderPersonPicker() {
    el('studyPersonPicker').innerHTML = REVIEWERS.map(p => `<button type="button" class="person-pill${p === S.person ? ' active' : ''}" data-person="${esc(p)}" style="--pill:${ACCENT[p]}" aria-pressed="${p === S.person}"><span class="pill-sprite">${spriteMarkup(p)}</span>${esc(p)}</button>`).join('');
  }

  // sessions running elsewhere (other people, or yours on another device / a closed tab)
  function renderStudyingNow() {
    const chips = activeSessions().map(s => {
      const mins = elapsedMin(s), stale = mins > STALE_HOURS * 60;
      const mine = s.person === S.person;
      return `<span class="now-chip${stale ? ' stale' : ''}" style="--pill:${ACCENT[s.person]}"><i></i>${esc(s.person)} ${stale ? 'left a timer running' : 'is studying'} at <b>${esc(s.place)}</b> · since ${esc(time12(s.start))}${s.date !== ymd(new Date()) ? ` ${esc(shortDate(s.date))}` : ''}${mine ? ` <button type="button" class="link-btn" data-remote-stop="${esc(s.id)}">${stale ? 'Fix end time' : 'Stop now'}</button>` : ''}</span>`;
    });
    el('studyingNow').innerHTML = chips.join('');
  }

  function ring(value, max, label, sub) {
    const r = 54, c = 2 * Math.PI * r, f = max ? Math.min(1, value / max) : 0;
    return `<div class="hero-ring" role="img" aria-label="${value} of ${max} days studied"><svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="${r}" class="ring-track"/><circle cx="66" cy="66" r="${r}" class="ring-fill" style="--c:${c};--off:${c * (1 - f)}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}"/></svg><div class="ring-center"><b>${label}</b><span>${sub}</span></div></div>`;
  }

  function renderSummary(st) {
    if (!st.count) {
      el('wrappedSummary').innerHTML = `<div class="month-hero empty"><div class="hero-main"><p class="eyebrow">${esc(st.person.toUpperCase())} · ${MONTHS[st.m].toUpperCase()} ${st.y}</p><div class="hero-total">0h</div><p class="hero-line">Nothing logged for ${MONTHS[st.m]} yet. Start a session — or log one you already did — and this page writes itself.</p></div>${ring(0, st.daysSoFar, '0', 'days')}</div>`;
      return;
    }
    const most = st.places[0];
    const slip = (icon, label, value, sub = '') => `<div class="sum-tile"><span class="sum-icon" aria-hidden="true">${icon}</span><span class="sum-label">${label}</span><b class="sum-value">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    el('wrappedSummary').innerHTML = `
      <div class="month-hero">
        <div class="hero-main">
          <p class="eyebrow">${esc(st.person.toUpperCase())} · ${MONTHS[st.m].toUpperCase()} ${st.y}</p>
          <div class="hero-total" data-countup="dur" data-to="${st.total}">${fmtDur(st.total)}</div>
          <p class="hero-line">studied across <b>${plural(st.count, 'session')}</b> at <b>${plural(st.places.length, 'spot')}</b></p>
          <div class="hero-chips"><span>🔥 ${st.streak.best}-day streak</span><span>⏱ ${fmtDur(st.avgSession)} avg session</span><span>📍 ${plural(st.newPlaces.length, 'new spot')}</span></div>
        </div>
        ${ring(st.days.length, st.daysSoFar, st.days.length, `of ${st.daysSoFar} days`)}
      </div>
      <div class="sum-grid">
        ${slip('📍', 'Most frequented', esc(most.place), plural(most.count, 'visit'))}
        ${slip('⭐', 'Favorite spot', st.favorite ? esc(st.favorite.place) : '—', st.favorite ? `${st.favorite.avg.toFixed(1)}/10 · ${st.favoriteSource}` : 'rate a session to unlock')}
        ${slip('📆', 'Per week', fmtDur(st.weekly), 'on average')}
        ${slip('🏃', 'Longest session', fmtDur(st.longest.minutes), `${esc(st.longest.place)} · ${shortDate(st.longest.date)}`)}
        ${slip('🧭', 'New spots', st.newPlaces.length, st.newPlaces[0] ? esc(st.newPlaces.map(p => p.place).slice(0, 2).join(', ')) : 'same favorites')}
        ${slip('📸', 'Photos · timelapses', `${st.photos.length} · ${st.timelapses.length}`, st.photos.length || st.timelapses.length ? 'in your journal' : 'none yet')}
      </div>`;
    animateCounts(el('wrappedSummary'));
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
      return [{ theme: 'cardinal', html: `<p class="eyebrow">STUDY WRAPPED // ${mon.toUpperCase()} ${st.y}</p><h2 class="wrap-title">${P}'s ${mon},<br><em>still wrapped.</em></h2><p class="wrap-copy">No sessions yet this month. Hit <b>Start Studying</b> and this deck fills itself in.</p><div class="wrap-sprite">${spriteMarkup(st.person)}</div>` }];
    }
    const comp = comparisons(st);
    const weeklyLine = comp.find(c => c.startsWith('You averaged')) || '';
    const cards = [];
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">STUDY WRAPPED // ${mon.toUpperCase()} ${st.y}</p><h2 class="wrap-title">${P}'s ${mon},<br><em>wrapped.</em></h2><p class="wrap-copy">${plural(st.count, 'session')}, ${plural(st.places.length, 'spot')} and a lot of laptop glow. Tap → to unwrap it.</p><div class="wrap-sprite">${spriteMarkup(st.person)}</div>` });
    cards.push({ theme: 'terminal', html: `<p class="eyebrow">01 // TOTAL TIME STUDIED</p><div class="wrap-prompt">C:\\STUDY\\${mon.toUpperCase().slice(0, 3)}&gt; total</div><div class="wrap-big" data-countup="dur" data-to="${st.total}">${fmtDur(st.total)}</div><p class="wrap-copy">${esc(comp[0])}</p>` });
    cards.push({ theme: 'paper', html: `<p class="eyebrow">02 // DATES YOU STUDIED</p><h2 class="wrap-title"><span data-countup="num" data-to="${st.days.length}">${st.days.length}</span> of ${st.daysSoFar} days.</h2>${miniMonth(st)}<p class="wrap-copy">${st.days.length === 1 ? `Just ${shortDate(st.days[0])} — a start.` : `First session ${shortDate(st.days[0])}, latest ${shortDate(st.days[st.days.length - 1])}.`}</p>` });
    cards.push({ theme: 'postcard', html: `<p class="eyebrow">03 // STUDY FREQUENCY</p><div class="wrap-trio"><div><b data-countup="num" data-to="${st.count}">${st.count}</b><span>${st.count === 1 ? 'session' : 'sessions'}</span></div><div><b>${fmtDur(st.avgSession)}</b><span>average session</span></div><div><b>${fmtDur(st.longest.minutes)}</b><span>longest · ${esc(st.longest.place)}</span></div></div><p class="wrap-copy">${st.count / Math.max(1, st.days.length) > 1.3 ? 'Double sessions on the regular. You love a comeback.' : 'Steady, one solid session at a time.'}</p>` });
    if (weeklyLine) cards.push({ theme: 'blue', html: `<p class="eyebrow">04 // WEEKLY AVERAGE</p><div class="wrap-big" data-countup="dur" data-to="${Math.round(st.weekly)}">${fmtDur(st.weekly)}</div><p class="wrap-sub">per week</p><p class="wrap-copy">${esc(weeklyLine)}</p>` });
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">05 // STUDY STREAK</p><div class="wrap-big">🔥 <span data-countup="num" data-to="${st.streak.best}">${st.streak.best}</span></div><p class="wrap-sub">${st.streak.best === 1 ? 'day in a row' : 'days in a row'}</p><p class="wrap-copy">${st.streak.best > 1 ? `${shortDate(st.streak.bestStart)} → ${shortDate(st.streak.bestEnd)}. The chain held.` : 'Every streak starts with day one. Next month: two.'}</p>` });
    const maxCount = st.places[0].count;
    cards.push({ theme: 'paper', html: `<p class="eyebrow">06 // MOST VISITED</p><h2 class="wrap-title">${st.places.length === 1 ? 'Your spot.' : 'Your rotation.'}</h2><ol class="wrap-bars">${st.places.slice(0, 5).map((p, i) => `<li style="--w:${Math.max(12, p.count / maxCount * 100)}%;--i:${i}"><span>${i + 1}. ${esc(p.place)}</span><b>${plural(p.count, 'visit')} · ${fmtDur(p.minutes)}</b></li>`).join('')}</ol>` });
    cards.push({ theme: 'terminal', html: `<p class="eyebrow">07 // NEW PLACES EXPLORED</p>${st.newPlaces.length ? `<div class="wrap-big" data-countup="num" data-to="${st.newPlaces.length}">${st.newPlaces.length}</div><p class="wrap-sub">${st.newPlaces.length === 1 ? 'new spot unlocked' : 'new spots unlocked'}</p><ul class="wrap-list">${st.newPlaces.slice(0, 6).map(p => `<li>+ ${esc(p.place)} <small>${esc(p.area)}</small></li>`).join('')}</ul>` : `<h2 class="wrap-title">No new spots.</h2><p class="wrap-copy">You know what you like. Next month, try one place off the list.</p>`}` });
    const fav = st.favorite;
    const trend = st.ratingAvg != null && st.prevRatingAvg != null ? ` Your average rating went ${st.ratingAvg >= st.prevRatingAvg ? '↑ up' : '↓ down'} from ${st.prevRatingAvg.toFixed(1)} to ${st.ratingAvg.toFixed(1)}.` : '';
    cards.push({ theme: 'postcard', html: `<p class="eyebrow">08 // FAVORITE SPOT</p>${fav ? `<h2 class="wrap-title">${esc(fav.place)}</h2><div class="wrap-big small" data-countup="dec" data-to="${fav.avg.toFixed(1)}">${fav.avg.toFixed(1)}<small>/10</small></div><p class="wrap-copy">Highest rated by ${esc(st.favoriteSource)}.${st.ratings.length ? ` You logged ${plural(st.ratings.length, 'spot rating')} this month${st.mostRated && st.mostRated.count > 1 ? `, rating ${esc(st.mostRated.place)} the most (${st.mostRated.count}×)` : ''}.` : ''}${trend}</p>` : `<h2 class="wrap-title">No favorite yet.</h2><p class="wrap-copy">Rate your sessions (★) and your favorite spot shows up here.</p>`}` });
    if (st.photos.length) cards.push({ theme: 'paper', html: `<p class="eyebrow">09 // PHOTOS FROM ${mon.toUpperCase()}</p><div class="wrap-collage">${st.photos.slice(0, 6).map((p, i) => `<figure style="--r:${[-3, 2, -1, 3, -2, 1][i]}deg"><img src="${esc(p.url)}" alt="${esc(p.place)}" loading="lazy" onerror="this.closest('figure').remove()"><figcaption>${esc(p.place)} · ${shortDate(p.date)}</figcaption></figure>`).join('')}</div>${st.photos.length > 6 ? `<p class="wrap-sub">+ ${st.photos.length - 6} more in the calendar</p>` : ''}` });
    if (st.timelapses.length) cards.push({ theme: 'terminal', html: `<p class="eyebrow">10 // TIMELAPSES</p><div class="wrap-reels">${st.timelapses.slice(0, 3).map(t => `<figure><video src="${esc(t.url)}" poster="${esc(posterOf(t.url))}" muted loop playsinline preload="none"></video><figcaption>${esc(t.place)} · ${shortDate(t.date)} · ${fmtDur(t.minutes)}</figcaption></figure>`).join('')}</div>` });
    const badges = achievementsFor(st).filter(b => b.isNew);
    const facts = comp.filter(c => c !== comp[0] && c !== weeklyLine).slice(0, 5);
    cards.push({ theme: 'cardinal', html: `<p class="eyebrow">11 // FUN FACTS</p>${facts.length ? `<ul class="wrap-facts">${facts.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}${badges.length ? `<div class="wrap-badges">${badges.map(b => `<span title="${esc(b.desc)}">${b.icon} ${esc(b.name)}</span>`).join('')}</div>` : ''}<p class="wrap-sign">— that's a wrap, ${P}. ✦</p>` });
    return cards;
  }

  function renderDeck(st) {
    const cards = deckCards(st);
    S.deckIndex = Math.min(S.deckIndex, cards.length - 1);
    el('wrappedDeck').innerHTML = `
      <div class="deck-progress">${cards.map((_, i) => `<i class="${i < S.deckIndex ? 'done' : i === S.deckIndex ? 'now' : ''}"></i>`).join('')}</div>
      <div class="deck-stage" tabindex="0" aria-roledescription="carousel" aria-label="Study Wrapped for ${MONTHS[st.m]} — use arrow keys">
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
    animateCounts(card);
  }
  function animateCounts(root) {
    if (reduceMotion()) return;
    root.querySelectorAll('[data-countup]').forEach(node => {
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

  // ---------------------------------------------------------------- rendering: calendar (shared or one person)
  function dayActivity(person, date) {
    const sessions = doneSessions(person).filter(s => s.date === date);
    const ratings = S.ratingLog.filter(r => (!person || r.person === person) && r.date === date);
    const photos = [
      ...sessions.flatMap(s => s.photos.map(url => ({ url, place: s.place, person: s.person }))),
      ...spotPhotosBy(person).filter(p => p.date === date).map(p => ({ url: p.url, place: p.place, person: p.person })),
    ];
    const timelapses = sessions.filter(s => s.timelapse);
    return { sessions, ratings, photos, timelapses, minutes: sessions.reduce((a, s) => a + s.minutes, 0) };
  }
  const level = (min, shared) => { const k = shared ? 1.6 : 1; return min <= 0 ? 0 : min < 60 * k ? 1 : min < 120 * k ? 2 : min < 240 * k ? 3 : 4; };

  function renderCalendar() {
    const shared = S.calMode === 'shared', who = shared ? null : S.person;
    const y = S.year, m = S.month, key = `${y}-${pad2(m + 1)}`, dim = new Date(y, m + 1, 0).getDate();
    const first = new Date(y, m, 1).getDay(), todayKey = ymd(new Date());
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span class="cal-pad"></span>';
    for (let d = 1; d <= dim; d++) {
      const date = `${key}-${pad2(d)}`, a = dayActivity(who, date), future = date > todayKey;
      const marks = [a.sessions.length > 1 ? `<i class="mk-multi" title="${a.sessions.length} sessions">${a.sessions.length}</i>` : '', a.ratings.length ? '<i class="mk-rate" title="Rated a spot">★</i>' : '', a.photos.length ? '<i class="mk-photo" title="Photos">◫</i>' : '', a.timelapses.length ? '<i class="mk-tl" title="Timelapse">▶</i>' : ''].join('');
      let people = '';
      if (shared) {
        const per = REVIEWERS.map(p => ({ p, min: a.sessions.filter(s => s.person === p).reduce((x, s) => x + s.minutes, 0) })).filter(x => x.min);
        people = per.length ? `<span class="cal-people">${per.map(x => `<i style="--pill:${ACCENT[x.p]};--w:${Math.max(18, Math.min(100, x.min / 240 * 100))}%" title="${esc(x.p)}: ${fmtDur(x.min)}"></i>`).join('')}</span>` : '';
      }
      const who2 = shared ? [...new Set(a.sessions.map(s => s.person))].join(', ') : '';
      const label = `${longDate(date)}: ${a.minutes ? `${fmtDur(a.minutes)} studied${who2 ? ` by ${who2}` : ''}` : 'no study'}${a.sessions.length > 1 ? `, ${a.sessions.length} sessions` : ''}`;
      cells += `<button type="button" class="cal-day lv${level(a.minutes, shared)}${date === todayKey ? ' today' : ''}${shared ? ' shared' : ''}" data-date="${date}" ${future ? 'disabled' : ''} aria-label="${esc(label)}" title="${esc(label)}"><span class="cal-num">${d}</span>${a.minutes ? `<span class="cal-min">${fmtDur(a.minutes)}</span>` : ''}${people}<span class="cal-marks">${marks}</span></button>`;
    }
    el('studyCalendar').innerHTML = `
      <div class="panel-head cal-head"><div><p class="eyebrow">${shared ? 'SHARED' : esc(S.person.toUpperCase()) + "'S"} CALENDAR // ${MONTHS[m].toUpperCase()}</p><h3>${shared ? 'Our month.' : `${esc(S.person)}'s month.`}</h3></div>
        <div class="seg small cal-toggle" role="tablist" aria-label="Calendar view"><button type="button" role="tab" class="seg-btn${shared ? ' active' : ''}" data-cal="shared" aria-selected="${shared}">Everyone</button><button type="button" role="tab" class="seg-btn${shared ? '' : ' active'}" data-cal="person" aria-selected="${!shared}">${esc(S.person)}</button></div></div>
      ${shared ? `<div class="cal-people-key">${REVIEWERS.map(p => `<span style="--pill:${ACCENT[p]}"><i></i>${esc(p)}</span>`).join('')}</div>` : ''}
      <div class="cal-grid${shared ? ' is-shared' : ''}">${WEEKDAYS.map(w => `<span class="cal-wd">${w}</span>`).join('')}${cells}</div>
      <div class="cal-legend"><span>Less</span>${[0, 1, 2, 3, 4].map(l => `<i class="lv${l}"></i>`).join('')}<span>More</span><span class="cal-key"><i class="mk-multi">2</i> sessions <i class="mk-rate">★</i> rating <i class="mk-photo">◫</i> photo <i class="mk-tl">▶</i> timelapse</span></div>`;
  }

  // ---------------------------------------------------------------- day drawer
  let viewer = { photos: [], i: 0 }, drawerDate = null;
  function sessionItem(s, showPerson) {
    return `
      <li class="day-session" data-id="${esc(s.id)}" style="--pill:${ACCENT[s.person]}">
        <div>${showPerson ? `<span class="who-tag">${esc(s.person)}</span> ` : ''}<b>${esc(s.place)}</b> <small>${esc(s.area)}</small></div>
        <div class="day-meta">${s.start ? `${esc(timeRange(s))} · ` : ''}${fmtDur(s.minutes)}${s.rating ? ` · ${stars(s.rating)}` : ''}${s.source === 'live' ? ' · <span class="live-tag">timed</span>' : ''}</div>
        ${s.studied ? `<div class="day-studied">📚 ${esc(s.studied)}</div>` : ''}
        ${s.notes ? `<p class="day-notes">${esc(s.notes)}</p>` : ''}
        ${s.photos.length ? `<div class="day-thumbs">${s.photos.map(u => `<img src="${esc(u)}" alt="" loading="lazy" data-photo-url="${esc(u)}">`).join('')}</div>` : ''}
        <div class="day-row-actions"><button type="button" class="link-btn" data-edit-session="${esc(s.id)}">Edit</button><button type="button" class="link-btn" data-rate-session="${esc(s.id)}">Rate this spot →</button><button type="button" class="link-btn danger" data-delete-session="${esc(s.id)}">Delete</button></div>
      </li>`;
  }
  function openDay(date) {
    drawerDate = date;
    const shared = S.calMode === 'shared', who = shared ? null : S.person;
    const a = dayActivity(who, date);
    const places = groupPlaces(a.sessions), people = [...new Set(a.sessions.map(s => s.person))];
    viewer = { photos: a.photos, i: 0 };
    const sessionsHTML = shared
      ? REVIEWERS.filter(p => people.includes(p)).map(p => { const list = a.sessions.filter(s => s.person === p); return `<section class="day-person" style="--pill:${ACCENT[p]}"><h4><span class="pill-sprite">${spriteMarkup(p)}</span>${esc(p)} <small>${fmtDur(list.reduce((x, s) => x + s.minutes, 0))}</small></h4><ul class="day-sessions">${list.map(s => sessionItem(s, false)).join('')}</ul></section>`; }).join('')
      : `<ul class="day-sessions">${a.sessions.map(s => sessionItem(s, false)).join('')}</ul>`;
    el('dayDrawerBody').innerHTML = `
      <p class="eyebrow">${shared ? 'EVERYONE' : esc(S.person.toUpperCase())} // DAY LOG</p>
      <h2>${longDate(date)}</h2>
      <div class="day-stats"><div><b>${fmtDur(a.minutes)}</b><span>studied</span></div><div><b>${a.sessions.length}</b><span>${a.sessions.length === 1 ? 'session' : 'sessions'}</span></div><div><b>${shared ? people.length : places.length}</b><span>${shared ? (people.length === 1 ? 'person' : 'people') : (places.length === 1 ? 'location' : 'locations')}</span></div></div>
      ${places.length ? `<div class="day-chips">${places.map(p => `<span>📍 ${esc(p.place)}</span>`).join('')}</div>` : ''}
      ${a.photos.length ? `<section class="day-viewer"><div class="viewer-frame"><img id="viewerImg" src="${esc(a.photos[0].url)}" alt=""><button type="button" class="viewer-nav prev" data-viewer="-1" aria-label="Previous photo">‹</button><button type="button" class="viewer-nav next" data-viewer="1" aria-label="Next photo">›</button><span class="viewer-count" id="viewerCount"></span></div><div class="viewer-thumbs">${a.photos.map((p, i) => `<button type="button" data-viewer-go="${i}" aria-label="Photo ${i + 1}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join('')}</div></section>` : ''}
      ${a.timelapses.length ? `<section><p class="eyebrow">TIMELAPSE${a.timelapses.length > 1 ? 'S' : ''}</p>${a.timelapses.map(s => `<figure class="day-reel"><video src="${esc(s.timelapse)}" poster="${esc(posterOf(s.timelapse))}" controls playsinline loop preload="metadata"></video><figcaption>${shared ? `${esc(s.person)} · ` : ''}${esc(s.place)} · ${esc(timeRange(s))}</figcaption></figure>`).join('')}</section>` : ''}
      ${a.sessions.length ? `<section><p class="eyebrow">SESSIONS</p>${sessionsHTML}</section>` : ''}
      ${a.ratings.length ? `<section><p class="eyebrow">RATINGS GIVEN</p><ul class="day-ratings">${a.ratings.map(r => `<li style="--pill:${ACCENT[r.person]}"><b>${shared ? `<span class="who-tag">${esc(r.person)}</span> ` : ''}${esc(r.place)}</b><span>${Number.isFinite(r.overall) ? r.overall.toFixed(1) + '/10' : '—'}</span><small>${esc(r.area)}</small>${r.notes ? `<p>${esc(r.notes)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}
      ${!a.sessions.length && !a.ratings.length && !a.photos.length ? `<div class="study-empty small"><h3>No study logged.</h3><p>Forgot to log it?</p><button type="button" class="study-btn" data-log-for="${date}">+ Log a session for this day</button></div>` : `<button type="button" class="study-btn ghost" data-log-for="${date}">+ Add a session for this day</button>`}`;
    updateViewer();
    if (el('dayDrawer').classList.contains('hidden')) {
      el('dayDrawer').classList.remove('hidden');
      document.body.classList.add('no-scroll');
      el('dayDrawer').querySelector('.drawer-panel').focus();
    }
  }
  function updateViewer() {
    const img = el('viewerImg'); if (!img || !viewer.photos.length) return;
    const p = viewer.photos[viewer.i];
    img.src = p.url; img.alt = `Photo at ${p.place}`;
    el('viewerCount').textContent = `${viewer.i + 1} / ${viewer.photos.length} · ${p.place}${S.calMode === 'shared' && p.person ? ` · ${p.person}` : ''}`;
    el('dayDrawerBody').querySelectorAll('[data-viewer-go]').forEach((b, i) => b.classList.toggle('on', i === viewer.i));
    el('dayDrawerBody').querySelectorAll('.viewer-nav').forEach(b => { b.hidden = viewer.photos.length < 2; });
  }
  function closeDrawer() {
    el('dayDrawer').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    el('dayDrawer').querySelectorAll('video').forEach(v => v.pause());
    drawerDate = null;
  }

  // ---------------------------------------------------------------- study diary (photo journal of the month)
  function renderDiary(st) {
    const list = [...st.sessions].reverse();
    if (!list.length) { el('studyDiary').innerHTML = ''; el('studyDiary').hidden = true; return; }
    el('studyDiary').hidden = false;
    const shown = S.diaryAll ? list : list.slice(0, 6);
    el('studyDiary').innerHTML = `
      <div class="panel-head"><p class="eyebrow">STUDY DIARY // ${esc(st.person.toUpperCase())}</p><h3>Pages from ${MONTHS[st.m]}.</h3></div>
      <ol class="diary">${shown.map(s => {
        const d = parseYMD(s.date);
        return `<li class="diary-entry"><button type="button" class="diary-date" data-open-day="${s.date}" aria-label="Open ${esc(longDate(s.date))}"><b>${d.getDate()}</b><span>${WEEKDAYS[d.getDay()]}</span></button>
          <div class="diary-body"><p class="diary-head"><b>${esc(s.place)}</b> <span>${fmtDur(s.minutes)}${s.start ? ` · ${esc(timeRange(s))}` : ''}</span>${s.rating ? ` ${stars(s.rating)}` : ''}</p>
          ${s.studied ? `<p class="diary-studied">📚 ${esc(s.studied)}</p>` : ''}${s.notes ? `<p class="diary-notes">“${esc(s.notes)}”</p>` : ''}
          ${s.photos.length || s.timelapse ? `<div class="diary-media">${s.photos.slice(0, 4).map((u, i) => `<img src="${esc(u)}" alt="" loading="lazy" style="--r:${[-2, 1.5, -1, 2][i]}deg">`).join('')}${s.timelapse ? `<span class="diary-tl">▶ timelapse</span>` : ''}</div>` : ''}</div></li>`;
      }).join('')}</ol>
      ${list.length > 6 ? `<button type="button" class="study-btn ghost" id="diaryMore">${S.diaryAll ? 'Show fewer' : `Show all ${list.length} entries`}</button>` : ''}`;
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
        return `<li class="lb-item"><span class="lb-icon">${c.icon}</span><div class="lb-body"><span class="lb-title">${c.title}</span>${winners.length ? `<b>${winners.map(w => esc(w.p)).join(' & ')}</b> <small>— ${esc(c.fmt(top))}</small>` : '<b>Up for grabs</b>'}<div class="lb-bars">${ranked.map(r => `<span style="--pill:${ACCENT[r.p]};--w:${top ? Math.max(4, r.v / top * 100) : 4}%" title="${esc(r.p)}: ${esc(c.fmt(r.v))}"><i></i><em>${esc(r.p)}</em></span>`).join('')}</div></div><span class="lb-sprites">${winners.length === 1 ? spriteMarkup(winners[0].p) : ''}</span></li>`;
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
    supported: !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && window.indexedDB),
    stream: null, video: null, timer: null, count: 0, interval: 3000, maxFrames: 600, facing: 'user', state: 'off', error: '',
  };
  const tlUnsupportedReason = () => !window.isSecureContext ? 'needs a secure (https) page' : !navigator.mediaDevices?.getUserMedia ? 'this browser has no camera access' : 'this browser can’t record video';
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

  // only one tab records the camera for a session
  function camOwnerElsewhere() { const o = load('studyCamOwner', null); return o && o.tab !== TAB_ID && Date.now() - o.t < 8000; }
  let ownerBeat = null;
  function claimCam() { store('studyCamOwner', { tab: TAB_ID, t: Date.now() }); clearInterval(ownerBeat); ownerBeat = setInterval(() => store('studyCamOwner', { tab: TAB_ID, t: Date.now() }), 3000); }
  function releaseCam() { clearInterval(ownerBeat); const o = load('studyCamOwner', null); if (o && o.tab === TAB_ID) store('studyCamOwner', undefined); }

  function cameraError(e) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    switch (e && e.name) {
      case 'NotAllowedError': return ios ? 'Camera blocked — allow it in Settings › Safari › Camera, then try again' : 'Camera blocked — allow camera for this site (padlock icon in the address bar), then try again';
      case 'NotFoundError': case 'OverconstrainedError': return 'No camera found on this device';
      case 'NotReadableError': return 'Camera is busy in another app';
      default: return 'Camera unavailable';
    }
  }
  async function startCamera() {
    if (!TL.supported) { TL.state = 'unsupported'; return false; }
    if (camOwnerElsewhere()) { TL.state = 'elsewhere'; return false; }
    try {
      stopCamera();
      TL.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: TL.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      TL.video = document.createElement('video');
      TL.video.muted = true; TL.video.playsInline = true; TL.video.setAttribute('playsinline', ''); TL.video.srcObject = TL.stream;
      await TL.video.play();
      TL.state = 'recording'; TL.error = '';
      claimCam();
      const prev = el('livePreview'); if (prev) { prev.srcObject = TL.stream; prev.play().catch(() => {}); }
      TL.stream.getVideoTracks()[0]?.addEventListener('ended', () => { TL.state = 'paused'; updateLiveStatus(); });
      return true;
    } catch (e) {
      TL.state = 'blocked'; TL.error = cameraError(e);
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
    const stamp = `${active.place.toUpperCase()}  ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    g.font = `600 ${Math.round(h / 22)}px "DM Mono", monospace`;
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillText(stamp, 15, h - 13);
    g.fillStyle = '#ffd88a'; g.fillText(stamp, 14, h - 14);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    if (!blob) return;
    await frameTx('readwrite', st => st.put({ k: `${active.id}:${String(Date.now()).padStart(15, '0')}`, blob }));
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
    return new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
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

  let wakeLock = null;
  async function holdWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (S.active && document.visibilityState === 'visible') { holdWake(); if (S.active.timelapse && !TL.stream && !camOwnerElsewhere()) resumeCamera(); } });

  // ---------------------------------------------------------------- live session
  let liveTick = null;
  async function startStudying({ person, place, area, studied, timelapse }) {
    if (S.active) return;     // one running session per device
    const now = new Date();
    const active = { id: newId(), person, place, area, studied: studied || '', date: ymd(now), start: hhmm(now), startedAt: now.toISOString(), startMs: now.getTime(), timelapse: !!timelapse && TL.supported };
    S.active = active; store('studyActive', active);
    store(`studyLastPlace:${person}`, { place, area });
    S.person = person; store('studyPerson', person);
    renderStudy();
    saveSession({ id: active.id, person, place, area, date: active.date, start: active.start, end: '', minutes: '', status: 'active', studied: active.studied, rating: '', notes: '', timelapse: '', source: 'live', startedAt: active.startedAt }).catch(() => {});
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
  function endLocalTiming() {
    clearInterval(TL.timer); clearInterval(liveTick);
    stopCamera(); releaseCam(); TL.state = 'off';
    try { wakeLock?.release(); } catch (_) {}
  }

  function renderLive() {
    const box = el('liveSession'), pill = el('liveNavPill');
    if (!S.active) { box.classList.add('hidden'); box.innerHTML = ''; pill?.classList.add('hidden'); return; }
    const a = S.active;
    const stale = Date.now() - a.startMs > STALE_HOURS * 3600e3;
    pill?.classList.remove('hidden');
    box.classList.remove('hidden');
    box.style.setProperty('--accent', ACCENT[a.person]);
    const defEnd = new Date(Math.min(Date.now(), a.startMs + 2 * 3600e3));
    box.innerHTML = `
      <div class="live-main">
        <p class="eyebrow">CURRENTLY STUDYING // ${esc(a.person.toUpperCase())}</p>
        <h2>📚 Studying at <em>${esc(a.place)}</em></h2>
        <div class="live-clock" id="liveClock" aria-live="off">${fmtClock((Date.now() - a.startMs) / 1000)}</div>
        <p class="live-meta">Started at ${esc(time12(a.start))}${a.date !== ymd(new Date()) ? ` on ${esc(shortDate(a.date))}` : ''}${a.studied ? ` · ${esc(a.studied)}` : ''}</p>
        <p class="live-tl" id="liveTlStatus"></p>
        ${stale ? `<div class="live-stale"><p>Still studying? This timer has been running a while.</p><label>I actually stopped at <input type="datetime-local" id="staleEnd" value="${ymd(defEnd)}T${hhmm(defEnd)}" min="${a.date}T${a.start}" max="${ymd(new Date())}T${hhmm(new Date())}"></label><button type="button" class="study-btn" id="staleSave">Save with that end time</button></div>` : ''}
        <div class="live-actions"><button type="button" class="study-btn stop" id="stopStudyBtn">■ Stop Study Session</button>${a.timelapse && TL.supported ? '<button type="button" class="study-btn ghost" id="flipCamBtn">⟲ Flip camera</button>' : ''}</div>
      </div>
      ${a.timelapse ? `<div class="live-cam${TL.facing === 'user' ? ' mirror' : ''}"><video id="livePreview" muted playsinline autoplay></video><span class="rec-dot">REC</span></div>` : ''}`;
    if (TL.stream) { const v = el('livePreview'); v.srcObject = TL.stream; v.play().catch(() => {}); }
    updateLiveStatus();
  }
  function updateLiveStatus() {
    const s = el('liveTlStatus'); if (!s || !S.active) return;
    const a = S.active;
    el('liveSession').querySelector('.live-cam')?.classList.toggle('off', !(TL.state === 'recording' && TL.stream));
    if (!a.timelapse) { s.innerHTML = TL.supported ? 'Timelapse ○ off' : `Timelapse ○ unavailable — ${esc(tlUnsupportedReason())}`; return; }
    if (TL.state === 'recording' && TL.stream) s.innerHTML = `Timelapse <span class="rec">●</span> Recording · ${plural(TL.count, 'frame')} · keep this tab open`;
    else if (TL.state === 'elsewhere') s.innerHTML = 'Timelapse ● Recording in another tab';
    else if (TL.state === 'blocked') s.innerHTML = `Timelapse ○ ${esc(TL.error)} — <button type="button" class="link-btn" id="resumeCamBtn">try again</button><br>Your timer keeps running either way.`;
    else if (TL.state === 'unsupported') s.innerHTML = `Timelapse ○ unavailable — ${esc(tlUnsupportedReason())}`;
    else s.innerHTML = `Timelapse ○ Paused · ${plural(TL.count, 'frame')} saved — <button type="button" class="link-btn" id="resumeCamBtn">resume camera</button>`;
  }

  async function stopStudying(endAt) {
    const a = S.active; if (!a || a.stopping) return;
    a.stopping = true;
    const btn = el('stopStudyBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const end = endAt || new Date();
    if (a.timelapse && TL.video && !endAt) await captureFrame(a).catch(() => {});
    endLocalTiming();
    const minutes = Math.max(1, Math.round((end.getTime() - a.startMs) / 60000));
    const rec = { id: a.id, person: a.person, place: a.place, area: a.area, date: a.date, start: a.start, end: hhmm(end), minutes, status: 'done', studied: a.studied, rating: '', notes: '', timelapse: '', source: 'live', startedAt: a.startedAt };
    S.active = null; store('studyActive', undefined);
    if (a.timelapse) store('studyPendingTimelapses', [...new Set([...load('studyPendingTimelapses', []), a.id])]);
    saveSession(rec).catch(() => {});
    renderStudy();
    openWrapUp(rec, a.timelapse && TL.supported);
  }

  // a session started on another device (or a closed browser that lost its local copy)
  function stopRemote(id) {
    const s = findSession(id); if (!s) return;
    if (elapsedMin(s) > STALE_HOURS * 60) return openLogModal({ mode: 'past', edit: { ...s, end: '' } });
    const end = new Date();
    const rec = { ...s, end: hhmm(end), minutes: elapsedMin(s), status: 'done' };
    saveSession(rec).catch(() => {});
    renderStudy();
    openWrapUp(rec, false);
  }

  // ---------------------------------------------------------------- modal: log / start / edit / wrap-up
  const modal = () => el('studyModal');
  function openModal(html) {
    modal().querySelector('.study-modal-body').innerHTML = html;
    modal().classList.remove('hidden');
    document.body.classList.add('no-scroll');
    modal().querySelector('input:not([type=radio]):not([type=hidden]),select,button:not(.close)')?.focus();
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
    if (selected && selected !== '__new' && !known.has(selected) && !mine.some(p => placeKey(p) === selected)) {
      const i = selected.indexOf('|'); mine.unshift({ area: selected.slice(0, i), place: selected.slice(i + 1) });
    }
    const opt = (area, name) => { const v = `${area}|${name}`; return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(name)}</option>`; };
    return `<option value="">Pick a spot…</option>${Object.entries(groups).map(([area, names]) => `<optgroup label="${esc(area === 'On Campus' ? 'USC Campus' : area)}">${names.sort((a, b) => a.localeCompare(b)).map(n => opt(area, n)).join('')}</optgroup>`).join('')}${mine.length ? `<optgroup label="Your other places">${mine.map(p => opt(p.area, p.place)).join('')}</optgroup>` : ''}<option value="__new">＋ Somewhere new…</option>`;
  }
  function starsHTML(name, value = 0) {
    return `<div class="star-input" role="radiogroup" aria-label="Rating">${[5, 4, 3, 2, 1].map(n => `<input type="radio" id="${name}-${n}" name="${name}" value="${n}"${n === value ? ' checked' : ''}><label for="${name}-${n}" title="${n} star${n > 1 ? 's' : ''}">★</label>`).join('')}</div>`;
  }
  function personPills(selected, locked) {
    return `<div class="pill-row" role="radiogroup" aria-label="Who is studying">${REVIEWERS.map(p => `<label class="person-pill radio${locked && p !== selected ? ' locked' : ''}" style="--pill:${ACCENT[p]}"><input type="radio" name="person" value="${esc(p)}"${p === selected ? ' checked' : ''}${locked && p !== selected ? ' disabled' : ''}><span class="pill-sprite">${spriteMarkup(p)}</span>${esc(p)}</label>`).join('')}</div>`;
  }
  const photoField = (existing = []) => `<div class="form-field full"><label>Photos <small>(optional)</small></label>${existing.length ? `<div class="photo-preview existing-photos">${existing.map(u => `<figure class="photo-thumb"><img src="${esc(u)}" alt=""><button type="button" class="photo-remove" data-existing="${esc(u)}" aria-label="Remove this photo">×</button></figure>`).join('')}</div>` : ''}<label class="photo-drop small">ADD PHOTOS<input type="file" id="sessionPhotos" accept="image/*,.heic,.heif,image/heic,image/heif" multiple><span>desk · view · snacks</span></label><div class="photo-preview" id="sessionPhotoPreview"></div></div>`;

  function openLogModal({ mode = 'start', date, edit } = {}) {
    if (edit) mode = 'past';
    if (S.active && mode === 'start') mode = 'past';
    const person = edit ? edit.person : S.person, last = load(`studyLastPlace:${person}`, null);
    const sel = edit ? placeKey(edit) : last ? `${last.area}|${last.place}` : '';
    const now = new Date();
    const remote = !edit && activeSessions().find(s => s.person === person);
    const start = edit?.start || `${pad2(Math.max(0, now.getHours() - 2))}:00`;
    const end = edit ? edit.end : `${pad2(now.getHours())}:00`;
    openModal(`
      <p class="eyebrow">${edit ? 'EDIT_SESSION.EXE' : 'LOG_SESSION.EXE'}</p>
      <h2 id="studyModalTitle">${edit ? 'Edit study session' : 'Log a study session'}</h2>
      ${edit ? '' : `<div class="seg" role="tablist">
        <button type="button" role="tab" class="seg-btn${mode === 'start' ? ' active' : ''}" data-mode="start" ${S.active ? 'disabled title="A session is already running on this device"' : ''}>▶ Start now</button>
        <button type="button" role="tab" class="seg-btn${mode === 'past' ? ' active' : ''}" data-mode="past">✎ Already studied</button>
      </div>`}
      ${remote ? `<p class="form-status error">${esc(person)} already has a session running at ${esc(remote.place)} since ${esc(time12(remote.start))}. <button type="button" class="link-btn" data-remote-stop="${esc(remote.id)}">Stop that one first</button></p>` : ''}
      <form id="sessionForm" data-mode="${mode}" ${edit ? `data-edit="${esc(edit.id)}"` : ''} novalidate>
        <div class="form-field full"><label>Who's studying?</label>${personPills(person, !!edit)}</div>
        <div class="form-field full"><label for="sessionPlace">Where?</label><select id="sessionPlace" name="place" required>${locationOptions(person, sel)}</select></div>
        <div class="form-grid new-loc hidden"><div class="form-field"><label for="newLocName">New spot name</label><input id="newLocName" name="newPlace" maxlength="120" placeholder="e.g. Doheny steps"></div><div class="form-field"><label for="newLocArea">Area</label><select id="newLocArea" name="newArea"><option value="On Campus">USC Campus</option><option value="K-Town">K-Town</option><option value="Fryft Zone">Fryft Zone</option><option value="Other">Somewhere else</option></select></div></div>
        <div class="form-field full"><label for="sessionStudied">What are you studying? <small>(optional)</small></label><input id="sessionStudied" name="studied" maxlength="200" value="${esc(edit?.studied || '')}" placeholder="e.g. CSCI 104 midterm"></div>
        <div class="mode-start">
          <label class="toggle"><input type="checkbox" name="timelapse" ${TL.supported ? 'checked' : 'disabled'}><span></span>Record a timelapse <small id="tlHint">${TL.supported ? 'uses your camera · keep this tab open while you study' : `unavailable — ${esc(tlUnsupportedReason())}`}</small></label>
          <button class="submit-rating study-submit" type="submit">▶ START STUDYING</button>
        </div>
        <div class="mode-past">
          <div class="form-grid">
            <div class="form-field"><label for="sessionDate">Date <small>(day you started)</small></label><input type="date" id="sessionDate" name="date" value="${edit?.date || date || ymd(now)}" max="${ymd(now)}"></div>
            <div class="form-field"><label for="sessionStart">Start time</label><input type="time" id="sessionStart" name="start" value="${start}"></div>
            <div class="form-field full"><label>Ended…</label><div class="seg small"><button type="button" class="seg-btn active" data-end="time">at a time</button><button type="button" class="seg-btn" data-end="dur">after a duration</button></div></div>
            <div class="form-field end-time"><label for="sessionEnd">End time <small>(earlier than start = next day)</small></label><input type="time" id="sessionEnd" name="end" value="${end}"></div>
            <div class="form-field end-dur hidden"><label>Duration</label><div class="dur-row"><input type="number" name="durH" min="0" max="23" value="${edit ? Math.floor(edit.minutes / 60) : 2}" aria-label="Hours"><span>h</span><input type="number" name="durM" min="0" max="59" step="5" value="${edit ? edit.minutes % 60 : 0}" aria-label="Minutes"><span>m</span></div></div>
          </div>
          <div class="form-field full"><label>How was it?</label>${starsHTML('rating', edit?.rating || 0)}</div>
          <div class="form-field full"><label for="sessionNotes">Notes</label><textarea id="sessionNotes" name="notes" maxlength="1000" placeholder="Outlets? Crowd? Best seat?">${esc(edit?.notes || '')}</textarea></div>
          ${photoField(edit?.photos || [])}
          <div class="form-field full"><label>Timelapse video <small>(optional — e.g. one you filmed on your phone)</small></label>${edit?.timelapse ? `<label class="toggle small-toggle"><input type="checkbox" name="removeTl"><span></span>Remove the current timelapse</label>` : ''}<input type="file" id="sessionVideo" accept="video/*"></div>
          <button class="submit-rating study-submit" type="submit">${edit ? 'SAVE CHANGES →' : 'SAVE SESSION →'}</button>
        </div>
        <div class="form-status" id="sessionStatus" role="status"></div>
      </form>`);
    picker.bind('sessionPhotos', 'sessionPhotoPreview');
    syncNewLoc();
    if (TL.supported && navigator.permissions?.query) navigator.permissions.query({ name: 'camera' }).then(p => { if (p.state === 'denied' && el('tlHint')) el('tlHint').textContent = 'camera is blocked for this site — allow it in your browser settings to record'; }).catch(() => {});
  }

  function openWrapUp(rec, hasTimelapse) {
    openModal(`
      <p class="eyebrow">SESSION_COMPLETE.EXE</p>
      <h2 id="studyModalTitle">Nice work, ${esc(rec.person)}.</h2>
      <p class="wrapup-sum"><b>${fmtDur(rec.minutes)}</b> at ${esc(rec.place)} · ${esc(timeRange(rec))}</p>
      ${hasTimelapse ? '<div class="wrapup-tl" id="wrapupTl"><div class="tl-progress"><i id="tlBar"></i></div><p id="tlMsg">Rendering your timelapse… keep this tab open for a moment.</p></div>' : ''}
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

  // render + upload a timelapse, then attach it to its session
  const tlJobs = {};
  function processTimelapse(id) {
    return tlJobs[id] ||= (async () => {
      const bar = () => el('tlBar'), msg = t => { const m = el('tlMsg'); if (m) m.innerHTML = t; };
      try {
        const blob = await renderTimelapse(id, p => { if (bar()) bar().style.width = `${Math.round(p * 100)}%`; });
        if (!blob) { msg('Not enough camera frames for a timelapse this time.'); await clearFrames(id); dropPending(id); return; }
        const box = el('wrapupTl');
        if (box && modal().querySelector(`#wrapupForm[data-id="${id}"]`)) box.insertAdjacentHTML('afterbegin', `<video class="tl-preview" src="${URL.createObjectURL(blob)}" controls playsinline loop muted autoplay></video>`);
        if (!findSession(id)) throw new Error('session not loaded yet');
        msg('Uploading timelapse…');
        const url = await uploadVideo(blob, id);
        await saveSession({ ...findSession(id), timelapse: url });
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

  // simple photo picker (HEIC-aware, removable thumbnails) + existing photos marked for removal
  const picker = {
    files: [], seq: 0, removing: new Set(),
    reset() { this.files.forEach(f => URL.revokeObjectURL(f.url)); this.files = []; this.removing = new Set(); },
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
    const person = form.querySelector('input[name=person]:checked')?.value || S.person, loc = readPlace(form);
    if (!loc) { setStatus(form.querySelector('#sessionPlace').value === '__new' ? 'Name the new spot first.' : 'Pick where you studied.', 'error'); return; }
    if (form.dataset.mode === 'start') {
      closeModal();
      await startStudying({ person, ...loc, studied: form.studied.value.trim(), timelapse: form.timelapse.checked });
      return;
    }
    const edit = form.dataset.edit ? findSession(form.dataset.edit) : null;
    const date = form.date.value, start = form.start.value;
    if (!date || date > ymd(new Date())) { setStatus('Pick a date (today or earlier).', 'error'); return; }
    if (!start) { setStatus('Add a start time.', 'error'); return; }
    let end, minutes;
    if (!form.querySelector('.end-dur').classList.contains('hidden')) {
      minutes = (Number(form.durH.value) || 0) * 60 + (Number(form.durM.value) || 0);
      const e = toMin(start) + minutes; end = `${pad2(Math.floor(e / 60) % 24)}:${pad2(e % 60)}`;
    } else {
      end = form.end.value; if (!end) { setStatus('Add an end time or switch to a duration.', 'error'); return; }
      minutes = minutesBetween(start, end);
    }
    if (minutes < 1 || minutes > 24 * 60) { setStatus('That session length looks off — check the times.', 'error'); return; }
    if (date === ymd(new Date()) && toMin(start) > toMin(hhmm(new Date())) + 1) { setStatus("That start time hasn't happened yet today.", 'error'); return; }
    const dup = findDuplicate({ person, date, start, minutes, ...loc }, edit?.id);
    if (dup && form.dataset.dupOk !== `${date}${start}${minutes}`) {
      form.dataset.dupOk = `${date}${start}${minutes}`;
      setStatus(`This overlaps a session you already logged: ${dup.place}, ${timeRange(dup)}. Tap save again to keep both.`, 'error');
      return;
    }
    const btn = form.querySelector('.mode-past .study-submit'); btn.disabled = true;
    try {
      const id = edit?.id || newId();
      let timelapse = edit && !form.removeTl?.checked ? edit.timelapse : '';
      const video = form.querySelector('#sessionVideo').files[0];
      if (video) { setStatus('Uploading timelapse video…'); timelapse = await uploadVideo(video, id); }
      setStatus('Saving session…');
      const rating = Number(form.querySelector('input[name="rating"]:checked')?.value) || '';
      const rec = { id, person, ...loc, date, start, end, minutes, status: 'done', studied: form.studied.value.trim(), rating, notes: form.notes.value.trim(), timelapse, source: edit?.source || 'manual', startedAt: edit?.startedAt || '' };
      await saveSession(rec);
      for (const url of picker.removing) { setStatus('Removing photos…'); await removeSessionPhoto(rec, url); }
      await addSessionPhotos(rec, picker.files.map(f => f.file), t => setStatus(t));
      store(`studyLastPlace:${person}`, loc);
      S.person = person; store('studyPerson', person);
      const d = parseYMD(date); S.year = d.getFullYear(); S.month = d.getMonth();
      const reopen = drawerDate;
      closeModal(); renderStudy(); refreshSoon();
      if (reopen) openDay(reopen);
    } catch (e) {
      setStatus(`Not saved: ${e.message}`, 'error');
    } finally { btn.disabled = false; }
  }

  async function submitWrapUp(form, skip) {
    const id = form.dataset.id;
    const btn = form.querySelector('.study-submit'); btn.disabled = true;
    try {
      if (!skip) {
        const details = { studied: form.studied.value.trim(), notes: form.notes.value.trim(), rating: Number(form.querySelector('input[name="rating"]:checked')?.value) || '' };
        setStatus('Saving…');
        await saveSession({ ...findSession(id), ...details });   // merged onto the latest record, so a finished timelapse link is kept
        await addSessionPhotos(findSession(id), picker.files.map(f => f.file), t => setStatus(t));
      }
      const rec = findSession(id);
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
    el('prevMonth').addEventListener('click', () => { if (--S.month < 0) { S.month = 11; S.year--; } S.deckIndex = 0; S.diaryAll = false; renderStudy(); });
    el('nextMonth').addEventListener('click', () => { if (++S.month > 11) { S.month = 0; S.year++; } S.deckIndex = 0; S.diaryAll = false; renderStudy(); });
    el('liveNavPill')?.addEventListener('click', () => { document.querySelector('.nav-link[data-view="study"]')?.click(); });

    view.addEventListener('click', e => {
      const t = e.target;
      const pill = t.closest('#studyPersonPicker .person-pill');
      if (pill) { S.person = pill.dataset.person; store('studyPerson', S.person); S.deckIndex = 0; S.diaryAll = false; renderStudy(); return; }
      if (t.closest('.deck-nav.next')) return goDeck(1);
      if (t.closest('.deck-nav.prev')) return goDeck(-1);
      const card = t.closest('.wrap-card.active');
      if (card && !t.closest('video,button,a')) { const r = card.getBoundingClientRect(); goDeck(e.clientX - r.left < r.width * 0.3 ? -1 : 1); return; }
      const calBtn = t.closest('[data-cal]'); if (calBtn) { S.calMode = calBtn.dataset.cal; store('studyCalMode', S.calMode); renderCalendar(); return; }
      const day = t.closest('.cal-day'); if (day && !day.disabled) return openDay(day.dataset.date);
      const od = t.closest('[data-open-day]'); if (od) return openDay(od.dataset.openDay);
      if (t.closest('#diaryMore')) { S.diaryAll = !S.diaryAll; renderDiary(statsFor(S.person, S.year, S.month)); return; }
      const rs = t.closest('[data-remote-stop]'); if (rs) return stopRemote(rs.dataset.remoteStop);
      if (t.closest('#stopStudyBtn')) return stopStudying();
      if (t.closest('#staleSave')) {
        const v = el('staleEnd').value, end = v ? new Date(v) : null;
        if (!end || isNaN(end) || end.getTime() <= S.active.startMs || end.getTime() > Date.now()) { el('staleEnd').setCustomValidity('Pick a time after you started and before now'); el('staleEnd').reportValidity(); return; }
        return stopStudying(end);
      }
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
      const thumb = t.closest('[data-photo-url]'); if (thumb) { const i = viewer.photos.findIndex(p => p.url === thumb.dataset.photoUrl); if (i >= 0) { viewer.i = i; updateViewer(); el('viewerImg')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
      const logFor = t.closest('[data-log-for]'); if (logFor) return openLogModal({ mode: 'past', date: logFor.dataset.logFor });
      const ed = t.closest('[data-edit-session]'); if (ed) return openLogModal({ edit: findSession(ed.dataset.editSession) });
      const rate = t.closest('[data-rate-session]');
      if (rate) { const s = findSession(rate.dataset.rateSession); closeDrawer(); return openRatingFor({ person: s.person, area: s.area, place: s.place, date: s.date }); }
      const del = t.closest('[data-delete-session]');
      if (del) {
        if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { if (del.isConnected) { delete del.dataset.confirm; del.textContent = 'Delete'; } }, 4000); return; }
        const s = findSession(del.dataset.deleteSession);
        del.disabled = true; del.textContent = 'Deleting…';
        try { await deleteSession(s); renderStudy(); openDay(s.date); } catch (err) { del.disabled = false; del.textContent = `Couldn't delete: ${err.message}`; }
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
      const ex = t.closest('[data-existing]'); if (ex) { const u = ex.dataset.existing, fig = ex.closest('figure'); if (picker.removing.has(u)) { picker.removing.delete(u); fig.classList.remove('removing'); } else { picker.removing.add(u); fig.classList.add('removing'); } return; }
      if (t.closest('#skipWrapup')) return submitWrapUp(el('wrapupForm'), true);
      const retry = t.closest('[data-retry-tl]'); if (retry) return processTimelapse(retry.dataset.retryTl);
      const rs = t.closest('[data-remote-stop]'); if (rs) { closeModal(); return stopRemote(rs.dataset.remoteStop); }
      const rp = t.closest('[data-rate-place]');
      if (rp) { const info = JSON.parse(rp.dataset.ratePlace); const wrap = el('wrapupForm'); (wrap ? submitWrapUp(wrap, false) : Promise.resolve()).then(() => { closeDrawer(); openRatingFor(info); }); }
    });
    m.addEventListener('change', e => {
      if (e.target.id === 'sessionPlace') syncNewLoc();
      if (e.target.name === 'person' && e.target.closest('#sessionForm') && !el('sessionForm').dataset.edit) {
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
      if (!modal().classList.contains('hidden')) { const wrap = modal().querySelector('#wrapupForm'); if (wrap) submitWrapUp(wrap, true); else closeModal(); }
      else if (!el('dayDrawer').classList.contains('hidden')) closeDrawer();
    });
    window.addEventListener('spots-loaded', () => { invalidate(); if (S.loaded) renderStudy(); });
    // keep tabs in sync: a session started or stopped in another tab shows up here too
    window.addEventListener('storage', e => {
      if (e.key !== 'studyActive') return;
      const next = load('studyActive', null);
      if (!next && S.active) { endLocalTiming(); S.active = null; }
      else if (next && (!S.active || S.active.id !== next.id)) { S.active = next; startTicking(); TL.state = 'elsewhere'; }
      renderStudy();
    });
    window.addEventListener('pagehide', () => releaseCam());
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!el('studyView')) return;
    bind();
    renderStudy();
    if (S.active) {           // the page was refreshed or the browser reopened mid-session
      startTicking();
      if (S.active.timelapse) resumeCamera();
      holdWake();
    }
    flushOutbox().finally(() => loadStudyData().catch(e => { console.error(e); S.loaded = true; renderStudy(); }));
    // finish timelapses that were recorded but never uploaded
    if (TL.supported) load('studyPendingTimelapses', []).forEach(id => { if (!S.active || S.active.id !== id) setTimeout(() => processTimelapse(id), 5000); });
    setInterval(() => { if (!document.hidden && !el('studyView').classList.contains('hidden')) loadStudyData().catch(() => {}); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.StudyWrapped = { statsFor, comparisons, achievementsFor, state: S, render: renderStudy, allSessions, invalidate };
})();
