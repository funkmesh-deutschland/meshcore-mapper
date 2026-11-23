/* Funkmesh Mapper – Empfangsdaten mit GPS erfassen (PWA, alles lokal auf dem Gerät).
 *
 * Quelle der Messwerte: MeshCore-Companion (Firmware „Companion Radio“) per Web Bluetooth/Serial.
 * Der Companion meldet jedes empfangene Paket als LogRxData-Push (RSSI, SNR, Rohdaten).
 * Wer gesendet hat, steht im Paket:
 *   - Flood-Paket mit Pfad: letzter Pfad-Hash = Repeater, den wir direkt gehört haben
 *   - Advert ohne Hop: voller Public Key des Absenders (bei Repeatern)
 * Direkt geroutete Pakete sind nicht eindeutig zuzuordnen und werden nicht gespeichert.
 */
import WebBleConnection from './vendor/meshcore/connection/web_ble_connection.js';
import WebSerialConnection from './vendor/meshcore/connection/web_serial_connection.js';
import Constants from './vendor/meshcore/constants.js';
import Packet from './vendor/meshcore/packet.js';
import Advert from './vendor/meshcore/advert.js';

const $ = (s) => document.querySelector(s);
const hex = (b) => Array.from(b || [], (x) => x.toString(16).padStart(2, '0')).join('');
const i8 = (v) => (v > 127 ? v - 256 : v);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '–' : Number(v).toFixed(d).replace('.', ',');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms); }

// ------------------------------------------------------------------ Speicher (IndexedDB) --
const DB = await new Promise((res, rej) => {
  const r = indexedDB.open('funkmesh-mapper', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    const rows = db.createObjectStore('rows', { keyPath: 'id', autoIncrement: true });
    rows.createIndex('session', 'session');
    db.createObjectStore('sessions', { keyPath: 'id' });
    db.createObjectStore('kv');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = (store, mode = 'readonly') => DB.transaction(store, mode).objectStore(store);
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const kvGet = (k) => req(tx('kv').get(k));
const kvSet = (k, v) => req(tx('kv', 'readwrite').put(v, k));
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

// ------------------------------------------------------------------ Zustand --
let conn = null;
let selfInfo = null;
let contacts = [];          // {key, name, type, lat, lon}
let recording = false;
let session = (await kvGet('session')) || null;
let fix = null;             // letzte GPS-Position
let wakeLock = null;
let lastTraceRx = null;     // zuletzt empfangenes Trace-Paket (RSSI für den Downlink)
const heard = new Set();
const settings = Object.assign({ setup: 'fuss', height: 1.5, maxAcc: 25, wake: true, traceOn: false, traceInt: 30, traceSel: [] },
  (await kvGet('settings')) || {});

// ------------------------------------------------------------------ Karte --
const map = L.map('map', { zoomControl: true }).setView([51.95, 7.3], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map);
const ptsLayer = L.layerGroup().addTo(map);
const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#fc790d', fillOpacity: 1 });
const meAcc = L.circle([0, 0], { radius: 1, color: '#fc790d', weight: 1, fillOpacity: 0.08 });
let followed = false;
const rssiColor = (r) => r === null || r === undefined ? '#111827' : r >= -90 ? '#0f766e' : r >= -105 ? '#14b8a6' : r >= -115 ? '#facc15' : r >= -122 ? '#fc790d' : '#dc2626';
function plot(row) {
  if (row.lat === null) return;
  L.circleMarker([row.lat, row.lon], { radius: 5, color: '#fff', weight: 1, fillColor: rssiColor(row.rssi), fillOpacity: 0.9 })
    .bindTooltip(`${esc(row.repeater_name || row.repeater)} · ${row.rssi ?? 'kein Empfang'} dBm`).addTo(ptsLayer);
}

// ------------------------------------------------------------------ GPS --
function updGpsPill() {
  const p = $('#p-gps');
  if (!fix) { p.textContent = 'GPS: –'; p.className = 'pill warn'; return; }
  const age = (Date.now() - fix.t) / 1000;
  p.textContent = `GPS ±${Math.round(fix.acc)} m${age > 10 ? ' (alt)' : ''}`;
  p.className = 'pill ' + (fix.acc <= settings.maxAcc && age <= 10 ? 'ok' : 'warn');
}
if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition((pos) => {
    const c = pos.coords;
    fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, speed: c.speed, t: pos.timestamp || Date.now() };
    me.setLatLng([fix.lat, fix.lon]).addTo(map); meAcc.setLatLng([fix.lat, fix.lon]).setRadius(fix.acc).addTo(map);
    if (!followed) { map.setView([fix.lat, fix.lon], 15); followed = true; }
    updGpsPill();
  }, (err) => { $('#p-gps').textContent = 'GPS: ' + err.message; $('#p-gps').className = 'pill warn'; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
} else { $('#p-gps').textContent = 'kein GPS'; }
setInterval(updGpsPill, 3000);

// ------------------------------------------------------------------ Datensatz --
function nameFor(hash) {
  if (!hash) return { name: '', ambiguous: false };
  const c = contacts.filter((x) => x.key.startsWith(hash) && (x.type === 2 || x.type === 3));
  if (c.length === 1) return { name: c[0].name, ambiguous: false };
  if (c.length > 1 && fix) {
    c.sort((a, b) => ((a.lat - fix.lat) ** 2 + (a.lon - fix.lon) ** 2) - ((b.lat - fix.lat) ** 2 + (b.lon - fix.lon) ** 2));
    return { name: c[0].name + ' ?', ambiguous: true };
  }
  return { name: '', ambiguous: false };
}

async function saveRow(r) {
  if (!session) await newSession();
  const f = fix;
  const row = {
    session: session.id, time: new Date().toISOString(),
    lat: f ? +f.lat.toFixed(7) : null, lon: f ? +f.lon.toFixed(7) : null,
    gps_accuracy: f ? Math.round(f.acc * 10) / 10 : null, gps_age_s: f ? Math.round((Date.now() - f.t) / 100) / 10 : null,
    altitude: f && f.alt !== null ? Math.round(f.alt * 10) / 10 : null, speed: f && f.speed !== null ? Math.round(f.speed * 10) / 10 : null,
    height: +settings.height, setup: settings.setup, ...r,
  };
  row.id = await req(tx('rows', 'readwrite').add(row));
  session.count = (session.count || 0) + 1;
  await req(tx('sessions', 'readwrite').put(session));
  if (row.repeater) heard.add(row.repeater);
  addLog(row); plot(row); updStats(row);
  return row;
}

function addLog(row) {
  const tb = $('#log');
  const tr = document.createElement('tr');
  const kind = { rx: 'Flood', rx_advert: 'Advert', trace: 'Trace ↓', trace_up: 'Trace ↑', trace_timeout: 'Trace –', manual: 'manuell', manual_none: 'manuell –' }[row.kind] || row.kind;
  tr.innerHTML = `<td>${row.time.slice(11, 19)}</td><td>${esc(row.repeater_name || row.repeater || '?')}</td>
    <td class="n" style="color:${rssiColor(row.rssi)}">${row.rssi ?? '–'}</td><td class="n">${fmt(row.snr, 1)}</td><td>${kind}</td>
    <td class="n">${row.gps_accuracy === null ? '–' : Math.round(row.gps_accuracy)}</td>`;
  tb.prepend(tr);
  while (tb.children.length > 40) tb.lastChild.remove();
}
function updStats(row) {
  $('#s-rows').textContent = session?.count || 0;
  $('#s-reps').textContent = heard.size;
  if (row && row.rssi !== null && row.rssi !== undefined) $('#s-last').textContent = `${row.rssi} dBm`;
}

// ------------------------------------------------------------------ Empfang auswerten --
function onRx(ev) {
  let pkt;
  try { pkt = Packet.fromBytes(ev.raw); } catch (e) { return; }
  const t = pkt.getPayloadType ? pkt.payload_type : null;
  if (t === Packet.PAYLOAD_TYPE_TRACE) { lastTraceRx = { t: Date.now(), rssi: ev.lastRssi, snr: ev.lastSnr }; return; }
  if (!recording) return;
  const hashes = pkt.getPathHashes().map(hex);
  const flood = pkt.route_type === Packet.ROUTE_TYPE_FLOOD || pkt.route_type === Packet.ROUTE_TYPE_TRANSPORT_FLOOD;
  let rep = '', name = '', kind = null;
  if (flood && hashes.length > 0) {
    rep = hashes[hashes.length - 1]; name = nameFor(rep).name; kind = 'rx';
  } else if (t === Packet.PAYLOAD_TYPE_ADVERT && hashes.length === 0) {
    try {
      const adv = Advert.fromBytes(pkt.payload);
      const ty = adv.getType();
      if (ty === Advert.ADV_TYPE_REPEATER || ty === Advert.ADV_TYPE_ROOM) {
        rep = hex(adv.publicKey); name = adv.parsed?.name || ''; kind = 'rx_advert';
      }
    } catch (e) { /* ungültig */ }
  }
  if (!kind) return; // nicht eindeutig zuzuordnen
  saveRow({ kind, repeater: rep, repeater_name: name, rssi: ev.lastRssi, snr: ev.lastSnr, direction: 'down',
    payload_type: pkt.payload_type_string || String(t), route: pkt.route_type_string, hops: hashes.length, path: hashes.join('>') });
}

// ------------------------------------------------------------------ Verbindung --
function noiseFloor() {
  const bwKhz = selfInfo ? selfInfo.radioBw / 1000 : 62.5;
  return -174 + 10 * Math.log10(bwKhz * 1000) + 6;
}
async function attach(c) {
  conn = c;
  conn.on('connected', async () => {
    $('#p-ble').textContent = 'Funk: verbunden'; $('#p-ble').className = 'pill ok';
    $('#b-disc').hidden = false;
    try {
      selfInfo = await conn.getSelfInfo(5000);
      $('#dev-info').textContent = `${selfInfo.name} · ${(selfInfo.radioFreq / 1000).toFixed(3)} MHz · BW ${selfInfo.radioBw / 1000} kHz · SF${selfInfo.radioSf} · CR4/${selfInfo.radioCr} · ${selfInfo.txPower} dBm`;
    } catch (e) { $('#dev-info').textContent = 'Verbunden (keine Geräteinfo)'; }
    await loadContacts();
  });
  conn.on('disconnected', () => {
    $('#p-ble').textContent = 'Funk: getrennt'; $('#p-ble').className = 'pill warn'; $('#b-disc').hidden = true; conn = null;
    toast('Companion getrennt');
  });
  conn.on(Constants.PushCodes.LogRxData, onRx);
}
$('#b-ble').onclick = async () => {
  try { const c = await WebBleConnection.open(); if (c) attach(c); }
  catch (e) { toast('Bluetooth: ' + e.message, 5000); }
};
if ('serial' in navigator) $('#b-usb').hidden = false;
$('#b-usb').onclick = async () => {
  try { const c = await WebSerialConnection.open(); if (c) attach(c); }
  catch (e) { toast('USB: ' + e.message, 5000); }
};
$('#b-disc').onclick = () => conn?.close();
if (!navigator.bluetooth) { $('#b-ble').disabled = true; $('#b-ble').textContent = 'Bluetooth im Browser nicht verfügbar'; }

async function loadContacts() {
  if (!conn) return;
  try {
    const cs = await conn.getContacts();
    contacts = cs.map((c) => ({ key: hex(c.publicKey), name: c.advName, type: c.type, lat: c.advLat / 1e6, lon: c.advLon / 1e6 }));
    $('#rep-names').innerHTML = contacts.filter((c) => c.type === 2).map((c) => `<option value="${esc(c.name)}">`).join('');
    renderTraceList();
  } catch (e) { toast('Kontakte nicht lesbar'); }
}

// ------------------------------------------------------------------ Aufnahme --
async function newSession() {
  const d = new Date();
  session = { id: d.getTime(), name: `Sitzung ${d.toLocaleString('de-DE')}`, count: 0 };
  await req(tx('sessions', 'readwrite').put(session));
  await kvSet('session', session);
  heard.clear(); updStats(); renderSessions();
}
async function setRecording(on) {
  recording = on;
  $('#b-rec').classList.toggle('on', on);
  $('#b-rec').textContent = on ? '■ Aufnahme pausieren' : '● Aufnahme starten';
  $('#p-rec').textContent = on ? 'Aufnahme' : 'Pause'; $('#p-rec').className = 'pill ' + (on ? 'rec' : '');
  if (on && !session) await newSession();
  if (on && settings.wake && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  if (!on && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && recording && settings.wake && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});
$('#b-rec').onclick = () => setRecording(!recording);

// ------------------------------------------------------------------ Aktiv-Test (Trace) --
function renderTraceList() {
  const reps = contacts.filter((c) => c.type === 2);
  $('#t-list').innerHTML = reps.length ? reps.map((c) => `<label class="item chk"><input type="checkbox" data-k="${c.key}" ${settings.traceSel.includes(c.key) ? 'checked' : ''}>
    ${esc(c.name)} <span class="r" id="tr-${c.key.slice(0, 12)}">${c.key.slice(0, 2)}</span></label>`).join('')
    : '<div class="hint">Keine Repeater in den Kontakten des Companions.</div>';
  document.querySelectorAll('#t-list input').forEach((el) => el.onchange = () => {
    const k = el.dataset.k;
    settings.traceSel = el.checked ? [...new Set([...settings.traceSel, k])] : settings.traceSel.filter((x) => x !== k);
    saveSettings();
  });
}
$('#t-load').onclick = loadContacts;
let traceBusy = false;
async function traceRound() {
  if (!settings.traceOn || !recording || !conn || traceBusy) return;
  traceBusy = true;
  try {
    for (const key of settings.traceSel) {
      const c = contacts.find((x) => x.key === key);
      const label = $(`#tr-${key.slice(0, 12)}`);
      const hash = key.slice(0, 2);
      const t0 = Date.now();
      try {
        const res = await conn.tracePath(new Uint8Array([parseInt(hash, 16)]), 3000);
        const upSnr = res.pathSnrs?.length ? i8(res.pathSnrs[0]) / 4 : null;
        const rx = lastTraceRx && lastTraceRx.t >= t0 ? lastTraceRx : null;
        await saveRow({ kind: 'trace', repeater: key, repeater_name: c?.name || '',
          rssi: rx ? rx.rssi : Math.round(noiseFloor() + res.lastSnr), rssi_source: rx ? 'rssi' : 'snr',
          snr: rx ? rx.snr : null, direction: 'down', payload_type: 'TRACE', route: 'DIRECT', hops: 1, path: hash });
        if (upSnr !== null) {
          // Pegel am Repeater aus SNR geschätzt: Rauschboden (BW, NF 6 dB) + SNR
          await saveRow({ kind: 'trace_up', repeater: key, repeater_name: c?.name || '', rssi: Math.round(noiseFloor() + upSnr),
            snr: null, direction: 'up', rssi_source: 'snr', payload_type: 'TRACE', route: 'DIRECT', hops: 1, path: hash });
        }
        if (label) label.textContent = `↓ ${rx ? rx.rssi + ' dBm' : fmt(res.lastSnr) + ' dB SNR'} · ↑ ${fmt(upSnr)} dB`;
      } catch (e) {
        await saveRow({ kind: 'trace_timeout', repeater: key, repeater_name: c?.name || '', rssi: null, snr: null, direction: 'down',
          payload_type: 'TRACE', route: 'DIRECT', hops: 1, path: hash });
        if (label) label.textContent = 'keine Antwort';
      }
    }
  } finally { traceBusy = false; }
}
let traceTimer = null;
function restartTrace() { clearInterval(traceTimer); traceTimer = setInterval(traceRound, Math.max(10, +settings.traceInt) * 1000); }
$('#t-on').checked = settings.traceOn; $('#t-int').value = settings.traceInt;
$('#t-on').onchange = (e) => { settings.traceOn = e.target.checked; saveSettings(); if (e.target.checked) traceRound(); };
$('#t-int').onchange = (e) => { settings.traceInt = +e.target.value; saveSettings(); restartTrace(); };
restartTrace();

// ------------------------------------------------------------------ Manuell --
function manualRep() {
  if (!fix || (Date.now() - fix.t) > 15000) { toast('Kein aktuelles GPS – Messpunkt ohne Position ist wertlos', 4000); return null; }
  const v = $('#m-rep').value.trim();
  if (!v) { toast('Repeater angeben'); return null; }
  const c = contacts.find((x) => x.name.toLowerCase() === v.toLowerCase());
  return c ? { repeater: c.key, repeater_name: c.name } : { repeater: v, repeater_name: '' };
}
$('#m-add').onclick = async () => {
  const r = manualRep(); if (!r) return;
  const rssi = $('#m-rssi').value === '' ? null : +$('#m-rssi').value;
  if (rssi === null) { toast('RSSI eintragen oder „Kein Empfang“ wählen'); return; }
  await saveRow({ kind: 'manual', ...r, rssi, snr: $('#m-snr').value === '' ? null : +$('#m-snr').value, direction: 'down' });
  toast('gespeichert');
};
$('#m-none').onclick = async () => {
  const r = manualRep(); if (!r) return;
  await saveRow({ kind: 'manual_none', ...r, rssi: null, snr: null, direction: 'down' }); toast('„kein Empfang“ gespeichert');
};

// ------------------------------------------------------------------ Einstellungen --
function saveSettings() { kvSet('settings', settings); }
$('#o-setup').value = settings.setup; $('#o-height').value = settings.height; $('#o-acc').value = settings.maxAcc; $('#o-wake').checked = settings.wake;
$('#o-setup').onchange = (e) => {
  settings.setup = e.target.value;
  if (e.target.value === 'aussenantenne' && +$('#o-height').value === 1.5) { $('#o-height').value = 2.0; settings.height = 2.0; }
  saveSettings();
};
$('#o-height').onchange = (e) => { settings.height = +e.target.value; saveSettings(); };
$('#o-acc').onchange = (e) => { settings.maxAcc = +e.target.value; saveSettings(); updGpsPill(); };
$('#o-wake').onchange = (e) => { settings.wake = e.target.checked; saveSettings(); };

// ------------------------------------------------------------------ Export --
const COLS = ['time', 'lat', 'lon', 'gps_accuracy', 'gps_age_s', 'altitude', 'speed', 'rssi', 'snr', 'repeater', 'repeater_name',
  'direction', 'height', 'setup', 'kind', 'payload_type', 'route', 'hops', 'path', 'rssi_source', 'session'];
async function allRows(sessionId = null) {
  const s = tx('rows');
  return sessionId === null ? req(s.getAll()) : req(s.index('session').getAll(sessionId));
}
// iPhone/iPad: <a download> mit Blob-URL funktioniert dort nicht zuverlässig (als Home-Bildschirm-App gar nicht,
// in Bluetooth-Browsern wie Bluefy ebenso wenig). Dort über das Teilen-Menü („In Dateien sichern“) exportieren.
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function shareFile(name, text, type) {
  if (!navigator.share || !navigator.canShare) return null;
  for (const t of [type, 'text/plain']) {
    const f = new File([text], name, { type: t });
    if (navigator.canShare({ files: [f] })) return f;
  }
  return null;
}
async function download(name, text, type) {
  if (IOS) {
    const f = shareFile(name, text, type);
    if (f) {
      try { await navigator.share({ files: [f], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }   // NotAllowedError: Geste durch async verbraucht → Dialog
    }
    return exportDialog(name, text, type);
  }
  saveLink(name, text, type);
}
function saveLink(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function exportDialog(name, text, type) {
  const f = shareFile(name, text, type);
  const d = document.createElement('div'); d.className = 'modal';
  d.innerHTML = `<div class="card"><h3>Export: ${esc(name)}</h3>
    <div class="hint">${(text.length / 1024).toFixed(1)} kB. ${f ? '„Teilen“ antippen und „In Dateien sichern“ wählen.' : 'Falls „Herunterladen“ hier nichts tut: Inhalt kopieren und z. B. in der Dateien- oder Notizen-App als .csv sichern.'}</div>
    <div class="row gap">
      ${f ? '<button class="btn primary" data-a="share">Teilen / Sichern</button>' : ''}
      <button class="btn" data-a="dl">Herunterladen</button>
      <button class="btn${f ? '' : ' primary'}" data-a="copy">Kopieren</button>
      <button class="btn" data-a="open">Anzeigen</button>
      <button class="btn" data-a="close">Schließen</button>
    </div><textarea readonly hidden></textarea></div>`;
  d.querySelector('textarea').value = text;
  document.body.appendChild(d);
  const close = () => d.remove();
  d.onclick = async (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (e.target === d || a === 'close') return close();
    try {
      if (a === 'share') { await navigator.share({ files: [f], title: name }); close(); }
      if (a === 'dl') saveLink(name, text, type);
      if (a === 'copy') { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert'); }
      if (a === 'open') { const t = d.querySelector('textarea'); t.hidden = false; t.focus(); t.select(); }
    } catch (err) { if (err.name !== 'AbortError') toast('Export: ' + err.message, 5000); }
  };
}
function toCsv(rows) {
  const q = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [COLS.join(','), ...rows.map((r) => COLS.map((c) => q(r[c])).join(','))].join('\n');
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
$('#b-csv').onclick = async () => { const rows = await allRows(); if (!rows.length) return toast('Keine Daten'); download(`funkmesh-messung-${stamp()}.csv`, toCsv(rows), 'text/csv'); };
$('#b-json').onclick = async () => {
  const rows = await allRows(); const sessions = await req(tx('sessions').getAll());
  download(`funkmesh-messung-${stamp()}.json`, JSON.stringify({ format: 'funkmesh-mapper/1', exported: new Date().toISOString(), device: selfInfo ? { name: selfInfo.name, freq_khz: selfInfo.radioFreq, bw_hz: selfInfo.radioBw, sf: selfInfo.radioSf, cr: selfInfo.radioCr, tx_dbm: selfInfo.txPower } : null, sessions, rows }), 'application/json');
};
$('#b-new').onclick = async () => { await newSession(); toast('Neue Sitzung'); };
$('#b-clear').onclick = async () => {
  const n = (await allRows()).length;
  if (!confirm(`Alle ${n} Messpunkte auf diesem Gerät endgültig löschen? (Vorher exportieren!)`)) return;
  await req(tx('rows', 'readwrite').clear()); await req(tx('sessions', 'readwrite').clear());
  session = null; await kvSet('session', null); ptsLayer.clearLayers(); $('#log').innerHTML = ''; heard.clear(); updStats(); renderSessions();
};
async function renderSessions() {
  const ss = (await req(tx('sessions').getAll())).sort((a, b) => b.id - a.id);
  $('#sess-name').textContent = session ? session.name : '';
  $('#sessions').innerHTML = ss.map((s) => `<div class="item">${esc(s.name)}<span class="r">${s.count || 0} Punkte</span>
    <button class="btn small" data-csv="${s.id}">CSV</button></div>`).join('');
  document.querySelectorAll('[data-csv]').forEach((b) => b.onclick = async () => {
    const rows = await allRows(+b.dataset.csv); download(`funkmesh-messung-${b.dataset.csv}.csv`, toCsv(rows), 'text/csv');
  });
}

// ------------------------------------------------------------------ Start --
(async () => {
  const rows = await allRows(session ? session.id : null);
  rows.slice(-2000).forEach((r) => { plot(r); if (r.repeater) heard.add(r.repeater); });
  rows.slice(-40).forEach(addLog);
  updStats(); renderSessions();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (!window.isSecureContext) toast('Achtung: keine HTTPS-Verbindung – GPS und Bluetooth sind gesperrt.', 8000);
})();
