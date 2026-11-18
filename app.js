'use strict';
const VERSION = '1.3';
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------- Zustand ----------
const est = Lean.createEstimator();
const opts = Object.assign({ swap: false, gps: true, demo: false }, store.get('opts', {}));
let cal = store.get('cal', null);
let lastT = null, leanDisp = 0, leanMax = 0;
let maxL = 0, maxR = 0;
let speed = null, speedT = 0, pos = null, gpsAcc = null, gpsWatch = null;
let sensorSeen = false, gyroOK = false, lastMotion = 0;
let accSeen = false, gyroSrc = null, lastGyro = null, sensorErr = null, motionCount = 0, motionHz = 0;
let gpsT = 0, gpsHead = null, gpsLean = 0;
let rec = null, lastSample = 0;
let demo = null;
let calib = null;
let wakeLock = null;

// ---------- Hilfen ----------
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const km = m => (m / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDate = t => new Date(t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const BANDS =[[20, 'var(--b1)', '#5fb3ff', 'unter 20°'], [30, 'var(--b2)', '#3ccf8e', '20–30°'], [40, 'var(--b3)', '#ffb020', '30–40°'], [50, 'var(--b4)', '#ff6a3d', '40–50°'], [999, 'var(--b5)', '#ff2e63', 'über 50°']];
const bandColor = a => BANDS.find(b => Math.abs(a) < b[0])[2];

// ---------- Speicher (IndexedDB) ----------
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const q = indexedDB.open('schraeglage', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('rides', { keyPath: 'id' });
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => {
    const t = d.transaction('rides', mode), r = fn(t.objectStore('rides'));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return { put: r => tx('readwrite', s => s.put(r)), all: () => tx('readonly', s => s.getAll()), del: id => tx('readwrite', s => s.delete(id)) };
})();

// ---------- Anzeige: Skala ----------
const ARC_R = 150;
const pt = (deg, r) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
(function drawTicks() {
  let h = '';
  for (let a = -60; a <= 60; a += 5) {
    const major = a % 10 === 0, [x1, y1] = pt(a, ARC_R + 4), [x2, y2] = pt(a, ARC_R + (major ? 16 : 10));
    h += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? '#8a97a6' : '#3a4656'}" stroke-width="${major ? 2.5 : 1.5}"/>`;
    if (major && a !== 0) { const [tx, ty] = pt(a, ARC_R - 14); h += `<text x="${tx}" y="${ty + 5}" fill="#8a97a6" font-size="14" text-anchor="middle" font-family="Roboto Condensed,Arial Narrow,sans-serif">${Math.abs(a)}</text>`; }
  }
  $('#ticks').innerHTML = h;
})();
function arc(a0, a1) {
  if (Math.abs(a1 - a0) < 0.3) return '';
  const [x0, y0] = pt(a0, ARC_R), [x1, y1] = pt(a1, ARC_R);
  return `M${x0},${y0} A${ARC_R},${ARC_R} 0 0 ${a1 > a0 ? 1 : 0} ${x1},${y1}`;
}

function render() {
  const a = Math.max(-60, Math.min(60, leanDisp)), shown = Math.round(Math.abs(leanDisp));
  $('#bike').setAttribute('transform', `rotate(${a})`);
  $('#arcL').setAttribute('d', a < 0 ? arc(0, a) : '');
  $('#arcR').setAttribute('d', a > 0 ? arc(0, a) : '');
  $('#maxMarkL').setAttribute('transform', `rotate(${-Math.min(60, maxL)})`);
  $('#maxMarkR').setAttribute('transform', `rotate(${Math.min(60, maxR)})`);
  $('#maxMarkL').style.opacity = maxL > 1 ? 1 : 0;
  $('#maxMarkR').style.opacity = maxR > 1 ? 1 : 0;
  $('#leanVal').textContent = shown;
  $('#sideL').classList.toggle('on', shown >= 1 && leanDisp < 0);
  $('#sideR').classList.toggle('on', shown >= 1 && leanDisp > 0);
  $('#maxL').firstChild.nodeValue = Math.round(maxL);
  $('#maxR').firstChild.nodeValue = Math.round(maxR);
  $('#speed').firstChild.nodeValue = speedFresh() != null ? Math.round(speed * 3.6) : '–';
}

function setChip(id, text, cls) { const c = $(id); c.textContent = text; c.className = 'chip' + (cls ? ' ' + cls : ''); }
function updateStatus() {
  const now = performance.now();
  if (demo) setChip('#chipSensor', 'Demo', 'warn');
  else if (!sensorSeen) setChip('#chipSensor', 'Kein Sensor', 'warn');
  else if (!gyroOK && sensorBlocked()) setChip('#chipSensor', 'Sensoren gesperrt', 'warn');
  else if (!gyroOK) setChip('#chipSensor', 'GPS-Modus', 'warn');
  else if (now - lastMotion > 1500 && gyroSrc === 'devicemotion') setChip('#chipSensor', 'Pausiert', 'warn');
  else setChip('#chipSensor', 'Sensor OK', 'ok');

  if (demo) setChip('#chipGps', 'GPS simuliert', 'warn');
  else if (!opts.gps) setChip('#chipGps', 'GPS aus');
  else if (gpsT && now - gpsT < 15000) setChip('#chipGps', 'GPS ±' + Math.round(gpsAcc || 0) + ' m', gpsAcc < 25 ? 'ok' : 'warn');
  else setChip('#chipGps', 'GPS sucht', 'warn');

  $('#diag').textContent = `Sensoren: Bewegung ${sensorSeen ? 'ja (' + motionHz + ' Hz)' : 'nein'}, Gyroskop ${gyroOK ? 'ja (' + (gyroSrc === 'sensor' ? 'Sensor-API' : 'DeviceMotion') + ')' : 'nein'}${sensorErr ? ', Sensor-API: ' + sensorErr : ''}, GPS ${gpsT ? 'ja' : 'nein'}.`;

  const ch = $('#chipRec');
  ch.hidden = !rec;
  if (rec) ch.textContent = '● ' + fmtDur((Date.now() - rec.start) / 1000);

  let hint = '', warn = false;
  if (!demo && !sensorSeen) { hint = 'Keine Bewegungssensoren gefunden. Die Seite muss über https geöffnet werden.'; warn = true; }
  else if (!demo && !gyroOK && sensorBlocked()) { hint = 'Chrome sperrt die Bewegungssensoren für diese Seite. Freigeben: Chrome → ⋮ → Einstellungen → Website-Einstellungen → Bewegungssensoren → erlauben, dann App neu starten. Bis dahin läuft der ungenauere GPS-Modus.'; warn = true; }
  else if (!demo && !gyroOK) { hint = 'Dein Handy liefert keine Gyroskop-Daten. Die Schräglage wird deshalb nur aus GPS-Tempo und Kurvenradius geschätzt: ungenauer und 1–2 s verzögert, im Stand immer 0°.'; warn = true; }
  else if (!cal && !demo) { hint = 'Noch nicht kalibriert. Motorrad gerade hinstellen und „Kalibrieren“ tippen.'; warn = true; }
  else if (rec) hint = 'Aufnahme läuft. Display nicht ausschalten, App nicht wechseln.';
  else hint = 'Aufnahme vor der Fahrt starten, Werte danach unter „Fahrten“ ansehen.';
  const h = $('#hint'); h.textContent = hint; h.classList.toggle('warn', warn);
}

// ---------- Sensorverarbeitung ----------
function speedFresh() {
  if (demo) return speed;
  return opts.gps && speed != null && performance.now() - speedT < 3000 ? speed : null;
}
function activeCal() { return cal || Lean.DEFAULT_CAL; }

function process(w, t) {
  if (lastT == null) { lastT = t; return; }
  const dt = t - lastT; lastT = t;
  if (dt <= 0 || dt > 0.5) return;
  const lean = est.step(activeCal(), w, speedFresh(), dt);
  afterLean(lean, t, dt, 0.12);
}

function afterLean(lean, t, dt, smooth) {
  leanDisp += (lean - leanDisp) * Math.min(1, dt / smooth);
  // Maximalwerte über ~0,3 s geglättet, damit Schläge der Fahrbahn nicht zählen
  leanMax += (lean - leanMax) * Math.min(1, dt / 0.3);
  if (leanMax < 0) maxL = Math.max(maxL, -leanMax); else maxR = Math.max(maxR, leanMax);
  if (rec && t - lastSample >= 0.1) { lastSample = t; recordSample(leanMax); }
}

function onMotion(e) {
  if (demo) return;
  sensorSeen = true; lastMotion = performance.now(); motionCount++;
  const rr = e.rotationRate, a = e.accelerationIncludingGravity;
  const acc = a && a.x != null ? [a.x, a.y, a.z] : null;
  if (acc) accSeen = true;
  const hasRR = !!(rr && rr.alpha != null && rr.beta != null);
  if (hasRR && gyroSrc !== 'sensor') { gyroOK = true; gyroSrc = 'devicemotion'; lastGyro = [rr.beta, rr.gamma, rr.alpha]; }
  if (calib) { calibSample(gyroOK ? lastGyro : null, acc); return; }
  if (gyroSrc === 'devicemotion' && hasRR) {
    const b = activeCal().bias || [0, 0, 0];
    process([lastGyro[0] - b[0], lastGyro[1] - b[1], lastGyro[2] - b[2]], e.timeStamp / 1000);
  }
}

// Chrome schickt bei gesperrten Sensoren nur ein einziges leeres Ereignis
function sensorBlocked() { return (sensorSeen && !accSeen) || /NotAllowed/.test(sensorErr || ''); }

// Zweiter Weg zum Gyroskop: Generic Sensor API (bei manchen Handys liefert DeviceMotion keine Drehraten)
function tryGyroscope() {
  if (!('Gyroscope' in window)) { sensorErr = 'nicht vorhanden'; return; }
  try {
    const g = new Gyroscope({ frequency: 60 });
    g.addEventListener('reading', () => {
      if (gyroSrc === 'devicemotion' || g.x == null) return;
      gyroSrc = 'sensor'; gyroOK = true; sensorErr = null; lastMotion = performance.now();
      const R = 180 / Math.PI; lastGyro = [g.x * R, g.y * R, g.z * R];
      if (calib || demo) return;
      const b = activeCal().bias || [0, 0, 0];
      process([lastGyro[0] - b[0], lastGyro[1] - b[1], lastGyro[2] - b[2]], g.timestamp / 1000);
    });
    g.addEventListener('error', e => { sensorErr = (e.error && (e.error.name + ': ' + e.error.message)) || 'Fehler'; });
    g.start();
  } catch (e) { sensorErr = e.name + ': ' + e.message; }
}

// Ersatz ohne Gyroskop: Schräglage aus GPS-Tempo und Richtungsänderung (tan φ = v·ω/g)
setInterval(() => {
  if (demo || gyroOK) return;
  const t = performance.now() / 1000, v = speedFresh();
  const target = v != null && v > 4 ? gpsLean : 0;
  afterLean(target, t, 0.05, 0.6);
}, 50);
setInterval(() => { motionHz = motionCount; motionCount = 0; }, 1000);

// ---------- Kalibrierung ----------
function startCalibration() {
  if (demo) { toggleDemo(false); }
  calib = { n: 0, ng: 0, acc: [0, 0, 0], acc2: 0, gyr: [0, 0, 0], gyr2: 0, t0: performance.now(), wait: 1000, dur: 2000 };
  $('#calMsg').textContent = ''; $('#calBar').style.width = '0';
  $('#calOverlay').hidden = false;
  if (!sensorSeen) setTimeout(() => { if (calib && !sensorSeen) failCal('Keine Sensordaten. Wird die Seite über https geöffnet?'); }, 2500);
}
function calibSample(w, acc) {
  const el = performance.now() - calib.t0;
  const remain = calib.wait + calib.dur - el;
  $('#calCount').textContent = Math.max(0, Math.ceil(remain / 1000));
  if (el < calib.wait) return;               // Antippen ausklingen lassen
  $('#calBar').style.width = Math.min(100, (el - calib.wait) / calib.dur * 100) + '%';
  if (acc) {
    calib.n++;
    for (let i = 0; i < 3; i++) calib.acc[i] += acc[i];
    calib.acc2 += acc[0] ** 2 + acc[1] ** 2 + acc[2] ** 2;
  }
  if (w) {
    calib.ng++;
    for (let i = 0; i < 3; i++) calib.gyr[i] += w[i];
    calib.gyr2 += w[0] ** 2 + w[1] ** 2 + w[2] ** 2;
  }
  if (remain <= 0) finishCal();
}
function finishCal() {
  const c = calib, n = c.n, ng = c.ng;
  if (n < 10) return failCal('Zu wenige Messwerte vom Beschleunigungssensor. Bitte erneut versuchen.');
  const ma = c.acc.map(x => x / n), mg = ng ? c.gyr.map(x => x / ng) : [0, 0, 0];
  const varA = c.acc2 / n - (ma[0] ** 2 + ma[1] ** 2 + ma[2] ** 2);
  const varG = ng ? c.gyr2 / ng - (mg[0] ** 2 + mg[1] ** 2 + mg[2] ** 2) : 0;
  const g = Math.hypot(...ma);
  if (varA > 0.15 || varG > 4 || g < 8 || g > 11.5) return failCal('Das Handy hat sich bewegt. Motorrad ruhig halten und noch einmal versuchen.');
  cal = Object.assign(Lean.axesFromGravity(ma, opts.swap), { bias: mg, acc: ma, t: Date.now() });
  store.set('cal', cal);
  est.reset(); leanDisp = 0; leanMax = 0; lastT = null;
  calib = null; $('#calOverlay').hidden = true;
  updateStatus();
}
function failCal(msg) { if (!calib) return; calib = null; $('#calMsg').textContent = msg; $('#calCount').textContent = '!';
  setTimeout(() => { if (!calib) $('#calOverlay').hidden = true; }, 3500); }

// ---------- GPS ----------
function startGps() {
  if (gpsWatch != null || !opts.gps || !('geolocation' in navigator)) return;
  gpsWatch = navigator.geolocation.watchPosition(p => {
    const c = p.coords, now = performance.now(), here = [c.latitude, c.longitude];
    let v = c.speed;
    if ((v == null || isNaN(v)) && pos && now - pos.t < 5000) v = haversine(pos.p, here) / ((now - pos.t) / 1000);
    if (v != null && !isNaN(v)) { speed = v; speedT = now; }
    gpsAcc = c.accuracy; gpsT = now;
    // Fahrtrichtung und deren Änderung für den GPS-Ersatzmodus
    let hd = c.heading;
    if ((hd == null || isNaN(hd)) && pos && haversine(pos.p, here) > 3) hd = bearing(pos.p, here);
    if (v != null && v > 4 && hd != null && !isNaN(hd)) {
      if (gpsHead) {
        const dt = (now - gpsHead.t) / 1000, d = ((hd - gpsHead.h + 540) % 360) - 180;
        if (dt > 0.3 && dt < 4) gpsLean = Math.max(-65, Math.min(65, Math.atan(v * d / dt * Math.PI / 180 / Lean.G) * 180 / Math.PI));
      }
      gpsHead = { h: hd, t: now };
    } else { gpsHead = null; gpsLean = 0; }
    if (rec && c.accuracy < 30) {
      if (rec.lastFix) rec.dist += haversine(rec.lastFix, here);
      rec.lastFix = here;
    }
    pos = { p: here, t: now };
  }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}
function stopGps() { if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; speed = null; }

// ---------- Display wach halten ----------
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rec) keepAwake(true); });

// ---------- Aufnahme ----------
function recordSample(lean) {
  const s = rec.s, sp = speedFresh();
  s.t.push(Math.round((Date.now() - rec.start) / 100) / 10);
  s.a.push(Math.round(lean * 10) / 10);
  s.v.push(sp == null ? null : Math.round(sp * 36) / 10);
  const p = demo ? demo.pos : pos && pos.p;
  s.lat.push(p ? +p[0].toFixed(6) : null); s.lon.push(p ? +p[1].toFixed(6) : null);
  if (sp != null) rec.vmax = Math.max(rec.vmax, sp * 3.6);
}
function summarize(r) {
  let mL = 0, mR = 0;
  for (const a of r.s.a) { if (a < mL) mL = a; if (a > mR) mR = a; }
  return { id: r.id, start: r.start, dur: (Date.now() - r.start) / 1000, dist: r.dist, vmax: r.vmax, maxL: -mL, maxR: mR, demo: !!demo, s: r.s };
}
async function toggleRec() {
  if (!rec) {
    rec = { id: 'r' + Date.now(), start: Date.now(), dist: 0, vmax: 0, lastFix: null, s: { t: [], a: [], v: [], lat: [], lon: [] } };
    maxL = maxR = 0; lastSample = 0;
    keepAwake(true); startGps();
    rec.timer = setInterval(() => { db.put(summarize(rec)).catch(() => {}); }, 30000);
  } else {
    clearInterval(rec.timer);
    const r = summarize(rec); rec = null; keepAwake(false);
    if (r.s.t.length > 20) { try { await db.put(r); } catch { alertBox('Fahrt konnte nicht gespeichert werden.'); } }
    else { try { await db.del(r.id); } catch {} }
  }
  $('#btnRec').textContent = rec ? 'Aufnahme beenden' : 'Aufnahme starten';
  $('#btnRec').classList.toggle('recording', !!rec);
  updateStatus();
}
function alertBox(msg) { const h = $('#hint'); h.textContent = msg; h.classList.add('warn'); }

// ---------- Demo ----------
function toggleDemo(on) {
  opts.demo = on; store.set('opts', opts); $('#optDemo').checked = on;
  if (demo) { clearInterval(demo.timer); demo = null; speed = null; }
  est.reset(); leanDisp = 0; leanMax = 0; lastT = null;
  if (on) {
    demo = { t: 0, phi: 0, v: 20, heading: 0, pos: [49.507, 11.465] };
    const bias = [0.4, -0.3, 0.2]; // Rest-Sensorfehler nach Kalibrierung, den der Filter ausgleichen muss
    let last = performance.now();
    demo.timer = setInterval(() => {
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      demo.t += dt;
      const t = demo.t;
      // Kurvenfolge: Wechselkurven unterschiedlicher Tiefe mit Geraden dazwischen
      const target = Math.sin(t * 0.55) * (28 + 16 * Math.sin(t * 0.13)) * (Math.abs(Math.sin(t * 0.21)) > 0.25 ? 1 : 0.1);
      const prev = demo.phi;
      demo.phi += (target - demo.phi) * Math.min(1, dt * 1.6);
      demo.v = 17 + 6 * Math.cos(t * 0.55 * 2);
      const syn = Lean.synth(activeCal(), demo.phi, (demo.phi - prev) / dt, demo.v);
      demo.heading += syn.yaw * dt * Math.PI / 180;
      demo.pos = [demo.pos[0] + Math.cos(demo.heading) * demo.v * dt / 111320,
                  demo.pos[1] - Math.sin(demo.heading) * demo.v * dt / (111320 * Math.cos(demo.pos[0] * Math.PI / 180))];
      if (rec && rec.lastDemo) rec.dist += haversine(rec.lastDemo, demo.pos);
      if (rec) rec.lastDemo = demo.pos.slice();
      speed = demo.v;
      const noise = () => (Math.random() - 0.5) * 1.5;
      const w = syn.w.map((x, i) => x + bias[i] + noise());
      process(w, now / 1000);
    }, 16);
  }
  updateStatus();
}

// ---------- Fahrten ----------
async function showRides() {
  if (mapInst) { try { mapInst.remove(); } catch {} mapInst = null; }
  $('#rideDetail').hidden = true; const list = $('#rideList'); list.hidden = false;
  let rides = [];
  try { rides = await db.all(); } catch { list.innerHTML = '<div class="empty">Der Speicher des Browsers ist nicht verfügbar.</div>'; return; }
  rides.sort((a, b) => b.start - a.start);
  if (!rides.length) { list.innerHTML = '<div class="empty">Noch keine Fahrten aufgezeichnet.<br>Unter „Messen“ die Aufnahme starten.<br>Zum Ausprobieren gibt es in den Einstellungen einen Demo-Modus.</div>'; return; }
  list.innerHTML = '';
  for (const r of rides) {
    const b = document.createElement('button'); b.className = 'ride';
    b.innerHTML = `<span class="t"></span><span class="s"></span><span class="m"></span>`;
    b.querySelector('.t').textContent = fmtDate(r.start) + (r.demo ? ' · Demo' : '');
    b.querySelector('.s').textContent = `${fmtDur(r.dur)} · ${km(r.dist)} km`;
    b.querySelector('.m').innerHTML = `${Math.round(r.maxL)}° | ${Math.round(r.maxR)}°<small>max L | R</small>`;
    b.onclick = () => showDetail(r);
    list.appendChild(b);
  }
}

function showDetail(r) {
  $('#rideList').hidden = true;
  const d = $('#rideDetail'); d.hidden = false;
  const s = r.s;
  // Zeitanteile je Schräglagenbereich
  const share = BANDS.map(() => 0);
  for (const a of s.a) share[BANDS.findIndex(b => Math.abs(a) < b[0])]++;
  const hasGps = s.lat.some(x => x != null);
  d.innerHTML = `
    <div class="row"><button id="back">← Alle Fahrten</button></div>
    <h2>${fmtDate(r.start)}${r.demo ? ' · Demo' : ''}</h2>
    <div class="kv">
      <div class="stat"><div class="k">Max links</div><div class="v">${Math.round(r.maxL)}<span class="u">°</span></div></div>
      <div class="stat"><div class="k">Max rechts</div><div class="v">${Math.round(r.maxR)}<span class="u">°</span></div></div>
      <div class="stat"><div class="k">V max</div><div class="v">${r.vmax ? Math.round(r.vmax) : '–'}<span class="u"> km/h</span></div></div>
      <div class="stat"><div class="k">Dauer</div><div class="v">${fmtDur(r.dur)}</div></div>
      <div class="stat"><div class="k">Strecke</div><div class="v">${km(r.dist)}<span class="u"> km</span></div></div>
      <div class="stat"><div class="k">Über 30°</div><div class="v">${Math.round((share[2] + share[3] + share[4]) / Math.max(1, s.a.length) * 100)}<span class="u"> %</span></div></div>
    </div>
    ${hasGps ? `<div class="card mapcard" id="mapCard"><div class="maphead"><h3>Strecke auf der Karte</h3><button id="mapFull" class="small">Vollbild</button></div>
      <div id="map" class="map"></div><canvas id="cvTrack" height="300" hidden></canvas>
      <div class="legend">${BANDS.map(b => `<span><i style="background:${b[1]}"></i>${b[3]}</span>`).join('')}</div>
      <p class="maphint" id="mapHint">Strecke antippen, um die Schräglage an dieser Stelle zu sehen.</p></div>` : ''}
    <div class="card"><h3>Schräglage über die Zeit</h3><canvas id="cvLean" height="200"></canvas>
      <div class="legend"><span>oben = rechts, unten = links</span></div></div>
    <div class="card"><h3>Zeitanteil je Bereich</h3><canvas id="cvHist" height="140"></canvas></div>
    <div class="row"><button id="exp">Als CSV speichern</button><button id="del" class="danger">Löschen</button></div>
    <div class="row" id="delConfirm" hidden><button id="delYes" class="danger">Wirklich löschen</button><button id="delNo">Behalten</button></div>`;
  $('#back').onclick = showRides;
  $('#exp').onclick = () => exportCsv(r);
  $('#del').onclick = () => { $('#delConfirm').hidden = false; };
  $('#delNo').onclick = () => { $('#delConfirm').hidden = true; };
  $('#delYes').onclick = async () => { try { await db.del(r.id); } catch {} showRides(); };
  requestAnimationFrame(() => {
    drawLeanChart($('#cvLean'), s);
    drawHist($('#cvHist'), share, s.a.length);
  });
  if (hasGps) {
    $('#mapFull').onclick = () => {
      const full = $('#mapCard').classList.toggle('full');
      $('#mapFull').textContent = full ? 'Schließen' : 'Vollbild';
      if (mapInst) setTimeout(() => { mapInst.invalidateSize(); mapInst.fitBounds(mapInst._track, { padding: [30, 30] }); }, 50);
    };
    loadLeaflet().then(() => { try { drawMap(r); } catch (e) { console.error(e); throw e; } }).catch(() => {
      // offline oder Karte nicht ladbar: einfache Streckenskizze statt Karte
      $('#map').hidden = true; $('#mapFull').hidden = true;
      $('#cvTrack').hidden = false; drawTrack($('#cvTrack'), s);
      $('#mapHint').textContent = 'Karte nicht verfügbar (keine Internetverbindung). Angezeigt wird eine Skizze der Strecke.';
    });
  }
}

// ---------- Karte (Leaflet + OpenStreetMap) ----------
let mapInst = null, leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletP) return leafletP;
  const base = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  leafletP = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = base + 'leaflet.js';
    js.onload = () => window.L ? res() : rej(); js.onerror = () => { leafletP = null; js.remove(); rej(); };
    document.head.appendChild(js);
    setTimeout(() => { if (!window.L) { leafletP = null; rej(); } }, 10000);
  });
  return leafletP;
}

function drawMap(r) {
  if (mapInst) { try { mapInst.remove(); } catch {} mapInst = null; }
  const el = $('#map'); if (!el || !el.isConnected) return;
  const s = r.s, idx = [];
  for (let i = 0; i < s.lat.length; i++) if (s.lat[i] != null) idx.push(i);
  if (idx.length < 2) return;
  const map = L.map(el, { zoomControl: true, attributionControl: true, tap: true });
  mapInst = map;
  // Ausschnitt setzen, bevor Linien dazukommen (Leaflet braucht eine Ansicht)
  map._track = L.latLngBounds(idx.map(i => [s.lat[i], s.lon[i]]));
  map.fitBounds(map._track, { padding: [30, 30] });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende'
  }).addTo(map);

  // Strecke in Abschnitte gleicher Farbe zerlegen
  const group = L.featureGroup().addTo(map);
  const bandOf = a => BANDS.findIndex(b => Math.abs(a) < b[0]);
  let seg = [], band = null;
  const flush = () => { if (seg.length > 1) L.polyline(seg, { color: BANDS[band][2], weight: 5, opacity: .95 }).addTo(group); };
  for (const i of idx) {
    const b = bandOf(s.a[i]), p = [s.lat[i], s.lon[i]];
    if (band !== null && b !== band) { seg.push(p); flush(); seg = [p]; } else seg.push(p);
    band = b;
  }
  flush();
  // breite unsichtbare Linie zum leichteren Antippen
  const hit = L.polyline(idx.map(i => [s.lat[i], s.lon[i]]), { weight: 24, opacity: 0 }).addTo(map);

  const tmin = i => fmtDur(s.t[i]);
  const vtxt = i => s.v[i] != null ? Math.round(s.v[i]) + ' km/h' : '';
  const dot = (cls, label) => L.divIcon({ className: 'mk ' + cls, html: label || '', iconSize: [18, 18], iconAnchor: [9, 9] });

  // markante Punkte suchen
  let iL = -1, iR = -1, iV = -1;
  for (const i of idx) {
    if (iL < 0 || s.a[i] < s.a[iL]) iL = i;
    if (iR < 0 || s.a[i] > s.a[iR]) iR = i;
    if (s.v[i] != null && (iV < 0 || s.v[i] > s.v[iV])) iV = i;
  }
  const bubbles = [];
  const bubble = (i, cls, html, pref) => bubbles.push({ m: L.marker([s.lat[i], s.lon[i]], { icon: dot(cls), zIndexOffset: 500 }).addTo(map), cls, html, pref });
  // Sprechblasen so ausrichten, dass sie sich nicht überdecken (bei jedem Zoom neu)
  const placeBubbles = () => {
    const placed = [], W = 135, H = 72;
    for (const b of bubbles) {
      const p = map.latLngToContainerPoint(b.m.getLatLng());
      const rect = (d, G) => d === 'left' ? [p.x - G - W, p.y - H / 2, p.x - G, p.y + H / 2]
        : d === 'right' ? [p.x + G, p.y - H / 2, p.x + G + W, p.y + H / 2]
        : d === 'top' ? [p.x - W / 2, p.y - G - H, p.x + W / 2, p.y - G] : [p.x - W / 2, p.y + G, p.x + W / 2, p.y + G + H];
      const hits = r => placed.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
      let dir = b.pref, gap = 10;
      search: for (const g of [10, 50, 90, 130, 170]) for (const d of [b.pref, 'right', 'left', 'top', 'bottom'])
        if (!hits(rect(d, g))) { dir = d; gap = g; break search; }
      placed.push(rect(dir, gap));
      const o = gap - 2, off = { left: [-o, 0], right: [o, 0], top: [0, -o], bottom: [0, o] }[dir];
      b.m.unbindTooltip().bindTooltip(b.html, { permanent: true, direction: dir, className: 'bubble ' + b.cls, offset: off });
    }
  };
  map.on('zoomend', placeBubbles);
  if (iL >= 0 && s.a[iL] < -1) bubble(iL, 'left', `<b>${Math.round(-s.a[iL])}° links</b><span>max. Schräglage</span><span>${[vtxt(iL), 'nach ' + tmin(iL)].filter(Boolean).join(' · ')}</span>`, 'left');
  if (iR >= 0 && s.a[iR] > 1) bubble(iR, 'right', `<b>${Math.round(s.a[iR])}° rechts</b><span>max. Schräglage</span><span>${[vtxt(iR), 'nach ' + tmin(iR)].filter(Boolean).join(' · ')}</span>`, 'right');
  if (iV >= 0) bubble(iV, 'speed', `<b>${Math.round(s.v[iV])} km/h</b><span>Höchsttempo</span><span>nach ${tmin(iV)}</span>`, 'top');
  placeBubbles();

  const first = idx[0], last = idx[idx.length - 1];
  L.marker([s.lat[first], s.lon[first]], { icon: dot('start', 'S') }).addTo(map)
    .bindPopup(`<b>Start</b><br>${fmtDate(r.start)}<br>${fmtDur(r.dur)} · ${km(r.dist)} km<br>max. ${Math.round(r.maxL)}° links · ${Math.round(r.maxR)}° rechts${r.vmax ? '<br>Höchsttempo ' + Math.round(r.vmax) + ' km/h' : ''}`);
  L.marker([s.lat[last], s.lon[last]], { icon: dot('finish', 'Z') }).addTo(map)
    .bindPopup(`<b>Ziel</b><br>nach ${fmtDur(s.t[last])}`);

  // Antippen der Strecke: Werte an der nächstgelegenen Stelle
  hit.on('click', e => {
    let best = idx[0], bd = Infinity;
    const k = Math.cos(e.latlng.lat * Math.PI / 180);
    for (const i of idx) { const dy = s.lat[i] - e.latlng.lat, dx = (s.lon[i] - e.latlng.lng) * k, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    const a = s.a[best], side = Math.abs(a) < 1 ? 'aufrecht' : (a < 0 ? 'links' : 'rechts');
    L.popup().setLatLng([s.lat[best], s.lon[best]])
      .setContent(`<b>${Math.round(Math.abs(a))}° ${side}</b><br>${[vtxt(best), 'nach ' + tmin(best)].filter(Boolean).join(' · ')}`).openOn(map);
  });
}

function prepCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = +cv.getAttribute('height');
  cv.style.height = h + 'px'; cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); return [c, w, h];
}
function drawLeanChart(cv, s) {
  const [c, w, h] = prepCanvas(cv);
  const padL = 30, padB = 18, iw = w - padL - 4, ih = h - padB - 6;
  const lim = Math.max(30, Math.ceil(Math.max(...s.a.map(Math.abs), 1) / 10) * 10);
  const T = s.t[s.t.length - 1] || 1;
  const X = t => padL + t / T * iw, Y = a => 6 + ih / 2 - a / lim * ih / 2;
  c.font = '11px system-ui'; c.fillStyle = '#8a97a6'; c.textAlign = 'right';
  for (let a = -lim; a <= lim; a += 10) {
    c.strokeStyle = a === 0 ? '#3a4656' : '#1c2531'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, Y(a)); c.lineTo(w - 4, Y(a)); c.stroke();
    if (a % 20 === 0) c.fillText(Math.abs(a) + '°', padL - 4, Y(a) + 4);
  }
  c.textAlign = 'center';
  const stepMin = T > 3600 ? 15 : T > 1200 ? 5 : T > 300 ? 2 : 1;
  for (let m = 0; m * 60 <= T; m += stepMin) c.fillText(m + ' min', Math.min(w - 20, Math.max(padL + 14, X(m * 60))), h - 4);
  // Verlauf, nach Bereich eingefärbt (bei langen Fahrten ausgedünnt)
  const step = Math.max(1, Math.floor(s.a.length / (iw * 2)));
  c.lineWidth = 1.6;
  for (let i = step; i < s.a.length; i += step) {
    c.strokeStyle = bandColor(s.a[i]);
    c.beginPath(); c.moveTo(X(s.t[i - step]), Y(s.a[i - step])); c.lineTo(X(s.t[i]), Y(s.a[i])); c.stroke();
  }
}
function drawTrack(cv, s) {
  const [c, w, h] = prepCanvas(cv);
  const pts = [];
  for (let i = 0; i < s.lat.length; i++) if (s.lat[i] != null) pts.push([s.lat[i], s.lon[i], s.a[i]]);
  if (pts.length < 2) return;
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const p of pts) { la0 = Math.min(la0, p[0]); la1 = Math.max(la1, p[0]); lo0 = Math.min(lo0, p[1]); lo1 = Math.max(lo1, p[1]); }
  const kx = Math.cos((la0 + la1) / 2 * Math.PI / 180);
  const sw = (lo1 - lo0) * kx || 1e-6, sh = (la1 - la0) || 1e-6, pad = 12;
  const k = Math.min((w - 2 * pad) / sw, (h - 2 * pad) / sh);
  const ox = (w - sw * k) / 2, oy = (h - sh * k) / 2;
  const P = p => [ox + (p[1] - lo0) * kx * k, h - oy - (p[0] - la0) * k];
  c.lineCap = 'round'; c.lineWidth = 4; c.strokeStyle = '#1c2531';
  c.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
  c.lineWidth = 3;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = P(pts[i - 1]), [x1, y1] = P(pts[i]);
    c.strokeStyle = bandColor(pts[i][2]); c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  const [sx, sy] = P(pts[0]); c.fillStyle = '#e8edf2'; c.beginPath(); c.arc(sx, sy, 5, 0, 7); c.fill();
}
function drawHist(cv, share, n) {
  const [c, w, h] = prepCanvas(cv);
  const bw = (w - 8 * (BANDS.length - 1)) / BANDS.length, max = Math.max(...share, 1);
  c.font = '11px system-ui'; c.textAlign = 'center';
  BANDS.forEach((b, i) => {
    const x = i * (bw + 8), bh = share[i] / max * (h - 40);
    c.fillStyle = b[2]; c.fillRect(x, h - 20 - bh, bw, bh);
    c.fillStyle = '#e8edf2'; c.fillText(Math.round(share[i] / Math.max(1, n) * 100) + ' %', x + bw / 2, h - 24 - bh);
    c.fillStyle = '#8a97a6'; c.fillText(b[3], x + bw / 2, h - 5);
  });
}
function exportCsv(r) {
  const s = r.s, rows = ['zeit_s;schraeglage_grad;tempo_kmh;breite;laenge'];
  for (let i = 0; i < s.t.length; i++) rows.push([s.t[i], s.a[i], s.v[i] ?? '', s.lat[i] ?? '', s.lon[i] ?? ''].join(';').replace(/\./g, ','));
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'schraeglage_' + new Date(r.start).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Navigation & Bedienung ----------
function show(view) {
  for (const [v, t] of [['#viewLive', '#tabLive'], ['#viewRides', '#tabRides'], ['#viewSettings', '#tabSettings']]) {
    $(v).hidden = v !== view; if (v === view) $(t).setAttribute('aria-current', 'page'); else $(t).removeAttribute('aria-current');
  }
  if (view === '#viewRides') showRides();
}
$('#tabLive').onclick = () => show('#viewLive');
$('#tabRides').onclick = () => show('#viewRides');
$('#tabSettings').onclick = () => show('#viewSettings');
$('#btnCal').onclick = startCalibration;
$('#calCancel').onclick = () => { calib = null; $('#calOverlay').hidden = true; };
$('#btnRec').onclick = toggleRec;
$('#btnReset').onclick = () => { maxL = maxR = 0; render(); };
$('#optSwap').checked = opts.swap; $('#optGps').checked = opts.gps;
$('#optSwap').onchange = e => {
  opts.swap = e.target.checked; store.set('opts', opts);
  if (cal) { cal = Object.assign(Lean.axesFromGravity(cal.acc, opts.swap), { bias: cal.bias, acc: cal.acc, t: cal.t }); store.set('cal', cal); }
  est.reset();
};
$('#optGps').onchange = e => { opts.gps = e.target.checked; store.set('opts', opts); opts.gps ? startGps() : stopGps(); };
$('#optDemo').onchange = e => toggleDemo(e.target.checked);
$('#buildInfo').textContent = 'Version ' + VERSION;

window.addEventListener('devicemotion', onMotion);
tryGyroscope();
startGps();
if (opts.demo) toggleDemo(true);
(function loop() { render(); requestAnimationFrame(loop); })();
setInterval(updateStatus, 500); updateStatus();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
