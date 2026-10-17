/* Madridistas Pubquiz — the big screen (?room=CODE&scherm) and the phones (?room=CODE).
   No server of our own: the big screen is the quiz master. It unlocks the encrypted question bank with the
   organiser key (#k=…, kept in this browser only), runs the rules from logic.js and sends every phone just its
   own view. Phones and screen meet on public MQTT relays; everything they send is AES-GCM encrypted with a key
   derived from the room code, under a topic name derived the same way. */
(() => {
'use strict';

/* ---------- routing & identity ---------- */
const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const IS_SCREEN = params.has('scherm');
const BASE = location.origin + location.pathname;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('nl-NL');
const fmt = n => nf.format(n);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function rid(n = 10) { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = new Uint32Array(n); crypto.getRandomValues(r); let s = ''; for (const x of r) s += a[x % a.length]; return s; }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }
function myId() {
  const key = IS_SCREEN ? 'mq.sid' : 'mq.pid';
  let id = lsGet(key, null);
  if (!id) { id = (IS_SCREEN ? 'scr_' : 'p_') + rid(12); lsSet(key, id); }
  return id;
}
const PID = myId();

// organiser key: arrives once as #k=…, then lives in this browser only (and leaves the address bar)
let QUIZ_KEY = lsGet('mq.key', null);
{
  const m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{20,})/);
  if (m) { QUIZ_KEY = m[1]; lsSet('mq.key', QUIZ_KEY); try { history.replaceState(null, '', BASE + location.search); } catch { /* ignore */ } }
}
// test hook: a local relay instead of the public ones (only ws://localhost)
const relayParam = params.get('relay');
if (relayParam && /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(relayParam)) lsSet('mq.relay', relayParam);
const LOCAL_RELAY = lsGet('mq.relay', '');
const RELAYS = LOCAL_RELAY ? [{ url: LOCAL_RELAY, o: {} }] : [
  { url: 'wss://public.cloud.shiftr.io', o: { username: 'public', password: 'public' } },
  { url: 'wss://broker.hivemq.com:8884/mqtt', o: {} },
  { url: 'wss://broker.emqx.io:8084/mqtt', o: {} },
];

const PEOPLE = [
  { name: 'Jasper', kit: 'JA', color: '#FF7A6B' }, { name: 'Bart', kit: 'BA', color: '#4CB8FF' },
  { name: 'Daan', kit: 'DA', color: '#FFD24A' }, { name: 'Pepijn', kit: 'PE', color: '#3EDB9B' },
  { name: 'Stijn', kit: 'ST', color: '#B48CFF' }, { name: 'Benoît', kit: 'BE', color: '#FF8FC7' },
];
const EXTRA_COLORS = ['#7DD3FC', '#FDBA74', '#A3E635', '#F9A8D4', '#67E8F9', '#FCD34D', '#C4B5FD', '#86EFAC'];

/* ---------- dom helpers ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') { for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv); }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}
const svgEl = markup => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
function kitSVG(color, label, cls = 'kit') {
  return svgEl(`<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true"><path d="M21 6 L9 11 L2 23 L11 29 L15 25 L15 58 L49 58 L49 25 L53 29 L62 23 L55 11 L43 6 C41 11 37 14 32 14 C27 14 23 11 21 6 Z" fill="${esc(color)}" stroke="rgba(10,18,49,.35)" stroke-width="1.5" stroke-linejoin="round"/><path d="M21 6 C23 11 27 14 32 14 C37 14 41 11 43 6" fill="none" stroke="rgba(10,18,49,.35)" stroke-width="2"/><text x="32" y="47" text-anchor="middle" font-family="'Big Shoulders Display','Arial Narrow',Impact,sans-serif" font-weight="900" font-size="21" fill="#0A1231">${esc(label)}</text></svg>`);
}
function shapeSVG(shape) {
  const p = { tri: '<path d="M12 3 L22 20 L2 20 Z"/>', dia: '<path d="M12 2 L22 12 L12 22 L2 12 Z"/>', dot: '<circle cx="12" cy="12" r="9.5"/>', sq: '<rect x="3" y="3" width="18" height="18" rx="2"/>' }[shape] || '';
  return svgEl(`<svg class="shape" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${p}</svg>`);
}
const SUN = '<svg class="sun" viewBox="0 0 48 48" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><circle cx="24" cy="24" r="8.5" fill="currentColor" stroke="none"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6M9.9 9.9l4.2 4.2M33.9 33.9l4.2 4.2M9.9 38.1l4.2-4.2M33.9 14.1l4.2-4.2"/></g></svg>';
const wordmark = () => h('div', { class: 'mark' }, h('span', { class: 'mark-sun', html: SUN }), h('span', { class: 'mark-name' }, 'Madridistas'), h('span', { class: 'mark-sub' }, 'Pubquiz'));
const app = document.getElementById('app');

/* ---------- sound / wake lock / confetti ---------- */
const Sound = {
  ctx: null, on: lsGet('mq.sound', true),
  wake() { if (this.ctx) { this.ctx.resume?.(); return; } try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; } },
  tone(f, t0, d, type = 'sine', g = 0.18) {
    const c = this.ctx; if (!c) return;
    const o = c.createOscillator(), v = c.createGain(); o.type = type; o.frequency.value = f;
    v.gain.setValueAtTime(0.0001, c.currentTime + t0); v.gain.exponentialRampToValueAtTime(g, c.currentTime + t0 + 0.012); v.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + d);
    o.connect(v).connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + d + 0.05);
  },
  whistle() {
    const c = this.ctx; if (!c) return;
    [0, 0.42].forEach((t, i) => {
      const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), v = c.createGain();
      o.frequency.value = 2650; lfo.frequency.value = 28; lg.gain.value = 140; lfo.connect(lg).connect(o.frequency);
      const d = i ? 0.55 : 0.28;
      v.gain.setValueAtTime(0.0001, c.currentTime + t); v.gain.exponentialRampToValueAtTime(0.12, c.currentTime + t + 0.02); v.gain.setValueAtTime(0.12, c.currentTime + t + d - 0.05); v.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t + d);
      o.connect(v).connect(c.destination); o.start(c.currentTime + t); lfo.start(c.currentTime + t); o.stop(c.currentTime + t + d + 0.05); lfo.stop(c.currentTime + t + d + 0.05);
    });
  },
  play(kind) {
    if (!this.on || !this.ctx) return;
    if (kind === 'whistle') this.whistle();
    else if (kind === 'tick') this.tone(1180, 0, 0.06, 'square', 0.05);
    else if (kind === 'reveal') [523.25, 659.25, 783.99].forEach((f, i) => this.tone(f, i * 0.09, 0.32, 'triangle', 0.16));
    else if (kind === 'fanfare') [392, 523.25, 659.25, 783.99, 659.25, 783.99].forEach((f, i) => this.tone(f, i * 0.14, i === 5 ? 0.9 : 0.24, 'triangle', 0.17));
    else if (kind === 'pop') this.tone(880, 0, 0.08, 'triangle', 0.08);
  },
};
let wakeLock = null;
async function keepAwake() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } } catch { wakeLock = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ROOM) keepAwake(); });
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = h('canvas', { class: 'confetti', 'aria-hidden': 'true' }); document.body.append(cv);
  const ctx = cv.getContext('2d'); const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
  const cols = ['#F4C24E', '#FFDB7D', '#F6F3EA', ...PEOPLE.map(p => p.color)];
  const parts = Array.from({ length: 180 }, () => ({ x: Math.random() * W, y: -Math.random() * H * 0.6, vx: (Math.random() - 0.5) * 3 * dpr, vy: (2 + Math.random() * 4) * dpr, s: (5 + Math.random() * 7) * dpr, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, c: cols[(Math.random() * cols.length) | 0] }));
  const t0 = performance.now();
  (function frame(t) {
    const el = t - t0; ctx.clearRect(0, 0, W, H); ctx.globalAlpha = el > 4200 ? Math.max(0, 1 - (el - 4200) / 900) : 1;
    for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += 0.04 * dpr; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
    if (el < 5100) requestAnimationFrame(frame); else cv.remove();
  })(t0);
}
let toastTimer = null;
function toast(text) {
  let t = $('#toast'); if (!t) { t = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- crypto ---------- */
const TE = new TextEncoder(), TD = new TextDecoder();
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
const unb64url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
let roomKey = null, topic = '';
async function deriveRoom(code) {
  const mat = await crypto.subtle.importKey('raw', TE.encode('mdq|' + code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: TE.encode('madridistas-pubquiz-2026'), iterations: 60000, hash: 'SHA-256' }, mat, 384));
  roomKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  topic = 'mdq26/' + Array.from(bits.slice(32, 44), b => b.toString(16).padStart(2, '0')).join('');
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, roomKey, TE.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function unseal(text) {
  const u = unb64(text);
  return JSON.parse(TD.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, roomKey, u.subarray(12))));
}
async function unlockRounds(k) {
  const raw = unb64(window.__MDQ_ENC__ || '');
  const key = await crypto.subtle.importKey('raw', unb64url(k), 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
  return JSON.parse(TD.decode(pt));
}

/* ---------- relay network ---------- */
let online = false;
const links = [];
const seenMsg = new Set(), seenOrder = [];
function firstSeen(id) { if (typeof id !== 'string' || seenMsg.has(id)) return false; seenMsg.add(id); seenOrder.push(id); if (seenOrder.length > 800) seenMsg.delete(seenOrder.shift()); return true; }
function netStart(onMessage, onConnect) {
  if (!window.mqtt || typeof window.mqtt.connect !== 'function') { toast('De verbinding kon niet laden. Herlaad de pagina.'); return; }
  const listen = topic + (IS_SCREEN ? '/u' : '/d');
  let connectTimer = null;
  for (const r of RELAYS) {
    let c;
    try { c = window.mqtt.connect(r.url, { ...r.o, clientId: 'mdq_' + rid(12), keepalive: 20, reconnectPeriod: 2500, connectTimeout: 9000, clean: true }); } catch { continue; }
    links.push(c);
    c.on('connect', () => {
      c.subscribe(listen, { qos: 0 });
      online = true;
      clearTimeout(connectTimer); connectTimer = setTimeout(onConnect, 150);
    });
    c.on('close', () => { const now = links.some(x => x.connected); if (online !== now) { online = now; render(); } });
    c.on('error', () => { /* it reconnects by itself */ });
    c.on('message', (_t, payload) => {
      unseal(payload.toString()).then(msg => { if (msg && firstSeen(msg.m)) onMessage(msg); }).catch(() => { /* not for us */ });
    });
  }
}
async function publish(kind, obj) {
  if (!roomKey) return false;
  const live = links.filter(c => c.connected);
  if (!live.length) return false;
  const text = await seal({ ...obj, m: rid(12) });
  for (const c of live) { try { c.publish(topic + '/' + kind, text, { qos: 0 }); } catch { /* reconnecting */ } }
  return true;
}

/* ---------- state shared by both roles ---------- */
let V = null;              // latest view
let offset = 0;            // quiz-master clock - local clock
const serverNow = () => Date.now() + offset;
let pending = {};          // player: qid -> answer sent, waiting for the quiz master
let needKey = false;       // screen: false | 'missing' | 'bad'
function setView(view) {
  const prev = V; V = view || null;
  if (!V) { render(); return; }
  if (IS_SCREEN) cues(prev, V);
  else if (V.ph !== 'q') pending = {};
  render();
}
function cues(a, b) {
  if (!a) return;
  if (b.ph !== a.ph || b.ri !== a.ri) {
    if (b.ph === 'intro') Sound.play('whistle');
    else if (b.ph === 'rev') Sound.play('reveal');
    else if (b.ph === 'end') { Sound.play('fanfare'); setTimeout(confetti, 300); }
  }
  if (b.ph === 'lobby' && b.pl && a.pl && b.pl.length > a.pl.length) Sound.play('pop');
}
function send(action) {
  if (IS_SCREEN) {
    if (!L || !G) return;
    const err = act(PID, action);
    if (err) toast(err); else commit();
    return;
  }
  publish('u', { t: 'act', pid: PID, a: action }).then(ok => {
    if (ok) return;
    toast('Even geen verbinding, probeer het zo nog eens');
    if (Object.keys(pending).length) { pending = {}; renderPlayer(true); }
  });
}

/* ==========================================================================
   QUIZ MASTER (big screen): runs the rules, stamps time and presence
   ========================================================================== */
let L = null;                       // the rules, after the question bank is unlocked
let G = null;                       // { status, seats, state }
const seenAt = new Map();           // phone pid -> last message time
const AWAY_MS = 25000;
const isOn = pid => { const t = seenAt.get(pid); return t != null && Date.now() - t < AWAY_MS; };
function onlineIds() { const now = Date.now(); const ids = [PID]; for (const [p, t] of seenAt) if (now - t < AWAY_MS) ids.push(p); return ids; }
const stamp = a => ({ ...(a && typeof a === 'object' && !Array.isArray(a) ? a : { value: a }), at: Date.now(), online: onlineIds() });
function clock(type) {
  if (!G || G.status !== 'playing') return;
  const a = stamp({ type });
  if (L.validateAction(G.state, '__clock', a).ok) G.state = L.applyAction(G.state, '__clock', a);
}
function seat(pid) {
  if (!G.seats.includes(pid) && G.seats.length < L.meta.maxPlayers) G.seats.push(pid);
  if (G.status === 'waiting' && G.seats.length >= L.meta.minPlayers) { G.state = L.setup(G.seats); G.status = 'playing'; }
}
function act(pid, action) {
  if (!G || G.status !== 'playing') return 'De quiz is nog niet klaar';
  let size = 0; try { size = JSON.stringify(action).length; } catch { return 'Dat snap ik niet'; }
  if (!size || size > 4096) return 'Dat snap ik niet';
  const a = stamp(action);
  const v = L.validateAction(G.state, pid, a);
  if (!v.ok) return v.error || 'Dat kan nu niet';
  G.state = L.applyAction(G.state, pid, a);
  return null;
}
const gameKey = () => 'mq.game.' + ROOM;
let wakeTimer = null, pubTimer = null, saveTimer = null;
function commit() {
  setView(L.viewFor(G.state, PID));
  clearTimeout(saveTimer); saveTimer = setTimeout(() => lsSet(gameKey(), G), 250);
  clearTimeout(wakeTimer); wakeTimer = null;
  const at = G.state && G.state.wakeAt;
  if (typeof at === 'number') wakeTimer = setTimeout(() => { clock('tick'); commit(); }, Math.max(0, at - Date.now()));
  queuePush();
}
function queuePush() { if (!pubTimer) pubTimer = setTimeout(pushState, 40); }
function pushState() {
  pubTimer = null;
  if (!G || !L) return;
  const views = {};
  for (const pid of onlineIds()) if (pid !== PID) views[pid] = L.viewFor(G.state, pid);
  publish('d', { t: 'st', now: Date.now(), v: views });
}
function fromPhone(msg) {
  const pid = typeof msg.pid === 'string' ? msg.pid : '';
  if (!/^p_[a-z0-9]{6,40}$/.test(pid)) return;
  const was = isOn(pid);
  if (msg.t === 'bye') { if (seenAt.delete(pid) && was) { clock('presence'); commit(); } return; }
  seenAt.set(pid, Date.now());
  let changed = false;
  if (!G.seats.includes(pid)) { seat(pid); changed = true; }
  if (!was) { clock('presence'); changed = true; }
  if (msg.t === 'act') {
    const err = act(pid, msg.a);
    if (err) publish('d', { t: 'err', pid, e: err }); else changed = true;
  }
  if (changed) commit(); else if (msg.t === 'join') queuePush();
}
async function bootScreen() {
  render();
  if (!QUIZ_KEY) { needKey = 'missing'; render(); return; }
  try { L = window.MDQ_makeLogic(await unlockRounds(QUIZ_KEY)); }
  catch { lsSet('mq.key', null); QUIZ_KEY = null; needKey = 'bad'; render(); return; }
  await deriveRoom(ROOM);
  const saved = lsGet(gameKey(), null);
  G = saved && Array.isArray(saved.seats) && saved.state && saved.state.v === 1 ? saved : { status: 'waiting', seats: [], state: null };
  seat(PID); clock('presence'); commit();
  netStart(fromPhone, () => { render(); queuePush(); });
  keepAwake();
}
setInterval(() => {
  if (!IS_SCREEN || !G) return;
  const now = Date.now(); let gone = false;
  for (const [p, t] of seenAt) if (now - t >= AWAY_MS) { seenAt.delete(p); gone = true; }
  if (gone) { clock('presence'); commit(); }
}, 3000);
setInterval(() => { if (IS_SCREEN && G && online) pushState(); }, 10000); // a fresh copy for anyone who missed one

/* ==========================================================================
   PHONE: talks to the quiz master
   ========================================================================== */
let lastState = 0, lastBeat = 0;
function fromMaster(msg) {
  if (msg.t === 'st' && msg.v && typeof msg.now === 'number') {
    const view = msg.v[PID];
    if (!view) return;
    lastState = Date.now();
    const o = msg.now + 120 - Date.now();
    offset = V ? offset * 0.6 + o * 0.4 : o;
    setView(view);
  } else if (msg.t === 'err' && msg.pid === PID) {
    toast(String(msg.e || 'Dat lukte niet'));
    if (Object.keys(pending).length) { pending = {}; renderPlayer(true); }
  }
}
function hello() {
  publish('u', { t: 'join', pid: PID }); lastBeat = Date.now();
  const mine = lsGet('mq.me', null);
  if (mine && lsGet('mq.room', '') === ROOM) send({ type: 'hello', n: mine.n, c: mine.c, k: mine.k });
}
async function bootPhone() {
  render();
  await deriveRoom(ROOM);
  netStart(fromMaster, () => { hello(); render(); });
}
setInterval(() => {
  if (IS_SCREEN || !roomKey || !online) return;
  const now = Date.now();
  if (!V || now - lastState > 20000) { publish('u', { t: 'join', pid: PID }); lastBeat = now; }
  else if (now - lastBeat >= 8000) { publish('u', { t: 'hb', pid: PID }); lastBeat = now; }
}, 3000);
addEventListener('pagehide', () => { if (!IS_SCREEN && roomKey) publish('u', { t: 'bye', pid: PID }); });

/* ==========================================================================
   RENDER
   ========================================================================== */
let lastKey = '';
function render() {
  if (!ROOM) return renderLanding();
  if (IS_SCREEN) return needKey ? renderKeyNeeded() : renderHost();
  renderPlayer();
}

/* ---------- landing (no room yet) ---------- */
function renderLanding() {
  app.dataset.view = 'player';
  const code = h('input', { id: 'code', class: 'field field-num', maxlength: '6', placeholder: 'CODE', autocomplete: 'off', autocapitalize: 'characters', enterkeyhint: 'go' });
  const last = lsGet('mq.lastScreen', '');
  const body = h('main', { class: 'p-body' },
    h('div', { class: 'p-card' }, h('p', { class: 'eyebrow' }, 'Meedoen'), h('h2', null, 'Typ de code van het grote scherm'),
      h('form', { class: 'p-numform', onsubmit: e => { e.preventDefault(); const c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length >= 3) location.href = BASE + '?room=' + c; else toast('Typ de code die op het grote scherm staat'); } },
        code, h('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, 'Doe mee'))));
  if (QUIZ_KEY) body.append(h('div', { class: 'p-card' }, h('p', { class: 'eyebrow' }, 'Groot scherm'), h('h2', null, 'Start de quiz op een laptop of tv'),
    h('p', null, 'Dit scherm toont de vragen en de stand en is de quizmaster: laat het open staan. Iedereen speelt mee op zijn eigen telefoon, jij ook.'),
    h('button', { class: 'btn btn-primary btn-wide', onclick: () => { let c = ''; const r = new Uint32Array(4); crypto.getRandomValues(r); for (const x of r) c += CODE_ABC[x % CODE_ABC.length]; lsSet('mq.lastScreen', c); location.href = BASE + '?room=' + c + '&scherm'; } }, 'Start een nieuwe quiz'),
    last ? h('button', { class: 'linkish', onclick: () => { location.href = BASE + '?room=' + last + '&scherm'; } }, `Verder met quiz ${last}`) : null));
  app.replaceChildren(h('div', { class: 'phone' }, h('header', { class: 'p-head' }, wordmark()), body));
}
function renderKeyNeeded() {
  app.dataset.view = 'player';
  const input = h('input', { id: 'key-in', class: 'field', placeholder: 'Plak hier de organisatorlink', autocomplete: 'off' });
  app.replaceChildren(h('div', { class: 'phone' }, h('header', { class: 'p-head' }, wordmark()), h('main', { class: 'p-body' }, h('div', { class: 'p-card' },
    h('p', { class: 'eyebrow' }, needKey === 'bad' ? 'Deze sleutel past niet' : 'Sleutel nodig'),
    h('h2', null, 'Alleen de organisator start de quiz'),
    h('p', null, 'Het grote scherm opent met de speciale organisatorlink. Open die link op dit apparaat, of plak hem hieronder.'),
    h('form', { class: 'p-numform', onsubmit: e => {
      e.preventDefault();
      const m = input.value.match(/k=([A-Za-z0-9_-]{20,})/) || input.value.trim().match(/^([A-Za-z0-9_-]{40,})$/);
      if (!m) { toast('Daar staat geen sleutel in'); return; }
      lsSet('mq.key', m[1]); location.reload();
    } }, input, h('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, 'Ontgrendel')),
    h('a', { class: 'linkish', href: BASE + '?room=' + ROOM }, 'Ik wil alleen meespelen')))));
}

/* ---------- host / big screen ---------- */
const host = { menuOpen: false, confirmReset: false, addOpen: false, lastSec: null };
const joinUrl = () => `${BASE}?room=${ROOM}`;
function renderHost() {
  app.dataset.view = 'host';
  if (!V) {
    app.replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'boot-mark', html: SUN }), h('p', null, 'Quiz klaarzetten…')));
    return;
  }
  const key = [V.game, V.ph, V.ri, V.qi].join(':');
  const fresh = key !== lastKey; lastKey = key;
  const stage = h('div', { class: 'host' + (fresh ? '' : ' noanim') }, hostBar());
  const main = h('main', { class: 'h-main' });
  if (V.ph === 'lobby') main.append(hostLobby());
  else if (V.ph === 'intro') main.append(hostIntro());
  else if (V.ph === 'q') main.append(hostQuestion(false));
  else if (V.ph === 'rev') main.append(hostQuestion(true));
  else main.append(hostBoard(V.ph === 'end'));
  stage.append(main, hostFoot());
  if (host.confirmReset) stage.append(confirmDialog());
  const focusId = document.activeElement && document.activeElement.id;
  const typed = $('#off-name') ? $('#off-name').value : '';
  app.replaceChildren(stage);
  if (focusId === 'off-name' && $('#off-name')) { $('#off-name').value = typed; $('#off-name').focus(); }
  tickHost();
  const bars = document.querySelectorAll('.bd-bar i');
  if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach(b => { b.style.width = b.dataset.w; })));
  else bars.forEach(b => { b.style.width = b.dataset.w; });
}
function hostBar() {
  const mid = h('div', { class: 'h-bar-mid' });
  if (V.ph !== 'lobby' && V.round) {
    mid.append(h('span', { class: 'chip chip-gold' }, `Ronde ${V.ri + 1}/${V.nr}`), h('span', { class: 'chip' }, V.round.title));
    if (V.ph === 'q' || V.ph === 'rev') mid.append(h('span', { class: 'chip chip-ghost' }, `Vraag ${V.qi + 1}/${V.round.n}`));
    if (V.round.mult > 1) mid.append(h('span', { class: 'chip chip-hot' }, `×${V.round.mult} punten`));
  }
  const n = V.pl.length;
  const right = h('div', { class: 'h-bar-right' });
  if (V.ph !== 'lobby') right.append(h('span', { class: 'chip chip-ghost' }, 'Meedoen: code ', h('b', null, ROOM)));
  right.append(h('span', { class: 'status ' + (online ? 'is-live' : 'is-off') }, h('i'), online ? `${n} speler${n === 1 ? '' : 's'}` : 'Verbinden…'));
  return h('header', { class: 'h-bar' }, wordmark(), mid, right);
}
const soundOnIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const soundOffIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
const fsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const dotsIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>';
function iconBtn(label, icon, fn) { return h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: fn, html: icon }); }
function toggleFullscreen() { try { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* unsupported */ } }
const hostCmd = (cmd, extra = {}) => { Sound.wake(); send({ type: 'host', cmd, ...extra }); };
function hostFoot() {
  const left = h('div', { class: 'h-foot-left' },
    iconBtn(Sound.on ? 'Geluid uit' : 'Geluid aan', Sound.on ? soundOnIcon : soundOffIcon, () => { Sound.on = !Sound.on; lsSet('mq.sound', Sound.on); Sound.wake(); renderHost(); }),
    iconBtn('Volledig scherm', fsIcon, toggleFullscreen));
  if (V.ph !== 'lobby' && V.ph !== 'end') {
    left.append(iconBtn(V.paused ? 'Verder' : 'Pauze', V.paused ? playIcon : pauseIcon, () => hostCmd(V.paused ? 'resume' : 'pause')));
    const menu = h('div', { class: 'menu-wrap' }, iconBtn('Meer', dotsIcon, () => { host.menuOpen = !host.menuOpen; renderHost(); }));
    if (host.menuOpen) menu.append(h('div', { class: 'menu', role: 'menu' },
      h('button', { role: 'menuitem', onclick: () => { host.menuOpen = false; hostCmd('auto', { on: !V.auto }); } }, V.auto ? 'Automatisch doorgaan uitzetten' : 'Automatisch doorgaan aanzetten'),
      h('button', { role: 'menuitem', onclick: () => { host.menuOpen = false; hostCmd('skipRound'); } }, 'Sla rest van ronde over'),
      h('button', { role: 'menuitem', class: 'danger', onclick: () => { host.menuOpen = false; host.confirmReset = true; renderHost(); } }, 'Nieuw spel beginnen…')));
    left.append(menu);
  }
  const mid = h('div', { class: 'h-foot-hint', id: 'auto-hint' });
  const right = h('div', { class: 'h-foot-right' });
  const label = primaryLabel();
  if (label) right.append(h('button', { class: 'btn btn-primary', id: 'primary', onclick: () => { if (V.ph === 'end') { host.confirmReset = true; renderHost(); } else hostCmd(V.ph === 'q' ? 'reveal' : 'next'); } }, label, h('span', { class: 'kbd' }, '→')));
  return h('footer', { class: 'h-foot' }, left, mid, right);
}
function primaryLabel() {
  switch (V.ph) {
    case 'lobby': return V.plan.length ? '¡Vamos! Start de quiz' : null;
    case 'intro': return 'Eerste vraag';
    case 'q': return 'Toon antwoord';
    case 'rev': return V.qi + 1 < V.round.n ? 'Volgende vraag' : (V.ri + 1 < V.nr ? 'Tussenstand' : 'Eindstand');
    case 'board': return V.ri + 1 < V.nr ? `Ronde ${V.ri + 2}` : 'Eindstand';
    case 'end': return 'Nieuw spel';
  }
  return null;
}
function confirmDialog() {
  return h('div', { class: 'scrim', onclick: e => { if (e.target === e.currentTarget) { host.confirmReset = false; renderHost(); } } },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      h('h2', null, 'Nieuw spel beginnen?'),
      h('p', null, 'Alle punten worden gewist. Wie nu meedoet, blijft aangemeld.'),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => { host.confirmReset = false; renderHost(); } }, 'Annuleer'),
        h('button', { class: 'btn btn-danger', onclick: () => { host.confirmReset = false; hostCmd('reset'); } }, 'Ja, opnieuw'))));
}
function qrSVG(text) {
  if (typeof window.qrcode !== 'function') return null;
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(); let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return svgEl(`<svg class="qr" viewBox="-3 -3 ${n + 6} ${n + 6}" role="img" aria-label="QR-code om mee te doen"><rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#fff"/><path d="${d}" fill="#0A1231"/></svg>`);
  } catch { return null; }
}
function hostLobby() {
  const url = joinUrl();
  const card = h('div', { class: 'qr-card' },
    h('p', { class: 'eyebrow' }, 'Doe mee, geen account nodig'),
    h('h1', { class: 'qr-title' }, 'Scan & speel'),
    qrSVG(url) || h('div', { class: 'qr-missing' }, url.replace(/^https?:\/\//, '')),
    h('div', { class: 'qr-code' }, h('span', null, 'Code'), h('strong', null, ROOM)),
    h('p', { class: 'qr-url' }, url.replace(/^https?:\/\//, '')));
  const side = h('div', { class: 'lobby-side' });
  side.append(h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('h2', null, 'Opstelling'), h('span', { class: 'count' }, `${V.pl.length} binnen`)),
    rosterEl(), addOfflineEl()));
  const prog = h('ol', { class: 'programme' });
  V.rounds.forEach((r, i) => {
    const on = V.plan.includes(i);
    prog.append(h('li', { class: on ? 'on' : 'off' }, h('button', { class: 'prog-toggle', 'aria-pressed': on ? 'true' : 'false', title: on ? 'Ronde overslaan' : 'Ronde meenemen', onclick: () => hostCmd('plan', { i }) },
      h('span', { class: 'prog-n' }, on ? String(V.plan.indexOf(i) + 1) : '–'), h('span', { class: 'prog-t' }, r.title), h('span', { class: 'prog-m' }, `${r.n} vragen${r.mult > 1 ? ` · ×${r.mult}` : ''}`))));
  });
  const nq = V.plan.reduce((s, i) => s + V.rounds[i].n, 0);
  const mins = Math.round(V.plan.reduce((s, i) => s + V.rounds[i].secs * V.speed + V.rounds[i].n * 14 * V.speed + 20, 0) / 60);
  side.append(h('div', { class: 'block' },
    h('div', { class: 'block-head' }, h('h2', null, 'Programma'), h('span', { class: 'count' }, `${nq} vragen · ±${mins} min`)), prog,
    h('div', { class: 'tempo' }, h('span', null, 'Tempo'), ...[[1.5, 'Rustig'], [1, 'Normaal'], [0.75, 'Snel']].map(([v, l]) => h('button', { class: 'seg' + (V.speed === v ? ' on' : ''), 'aria-pressed': V.speed === v ? 'true' : 'false', onclick: () => hostCmd('speed', { v }) }, l))),
    h('div', { class: 'tempo' }, h('span', null, 'Doorgaan'), h('button', { class: 'seg' + (V.auto ? ' on' : ''), onclick: () => hostCmd('auto', { on: true }) }, 'Automatisch'), h('button', { class: 'seg' + (!V.auto ? ' on' : ''), onclick: () => hostCmd('auto', { on: false }) }, 'Met de knop'))));
  side.append(h('p', { class: 'note' }, (V.auto ? 'De quiz loopt vanzelf door, dus iedereen kan meespelen. Ook jij: scan de code met je eigen telefoon.' : 'Je klikt zelf door naar de volgende vraag. Meespelen kan nog steeds via je eigen telefoon.') + ' Dit scherm is de quizmaster: houd dit tabblad open.'));
  return h('section', { class: 'lobby' }, card, side);
}
function rosterEl() {
  const box = h('ul', { class: 'roster', id: 'roster' });
  const list = [...V.pl].sort((a, b) => a.j - b.j);
  if (!list.length) box.append(h('li', { class: 'roster-empty' }, 'Nog niemand binnen. Scan de code om de opstelling te vullen.'));
  for (const p of list) {
    const li = h('li', { class: 'player' + (p.on || p.off ? '' : ' away') }, kitSVG(p.c, p.k), h('span', { class: 'pname' }, p.n));
    if (p.off) li.append(h('span', { class: 'tag' }, 'zonder tel.'));
    else if (!p.on) li.append(h('span', { class: 'tag' }, 'weg'));
    if (p.off || !p.on) li.append(h('button', { class: 'x', title: `Verwijder ${p.n}`, 'aria-label': `Verwijder ${p.n}`, onclick: () => hostCmd('remove', { pid: p.pid }) }, '×'));
    box.append(li);
  }
  return box;
}
function addOfflineEl() {
  if (!host.addOpen) return h('button', { class: 'linkish', onclick: () => { host.addOpen = true; renderHost(); setTimeout(() => $('#off-name')?.focus(), 0); } }, '+ Speler zonder telefoon');
  const input = h('input', { id: 'off-name', class: 'field', maxlength: '18', placeholder: 'Naam', autocomplete: 'off' });
  return h('form', { class: 'add-off', onsubmit: e => { e.preventDefault(); host.addOpen = false; hostCmd('addOffline', { n: input.value }); } },
    input, h('button', { class: 'btn btn-s', type: 'submit' }, 'Voeg toe'), h('button', { class: 'btn btn-ghost btn-s', type: 'button', onclick: () => { host.addOpen = false; renderHost(); } }, 'Annuleer'));
}
function hostIntro() {
  const r = V.round;
  return h('section', { class: 'intro' }, h('div', { class: 'intro-circle', 'aria-hidden': 'true' }),
    h('p', { class: 'eyebrow' }, `Ronde ${V.ri + 1} van ${V.nr}`), h('h1', { class: 'intro-title' }, r.title), h('p', { class: 'intro-blurb' }, r.blurb),
    h('div', { class: 'intro-meta' }, h('span', null, `${r.n} vragen`), r.mult > 1 ? h('span', { class: 'hot' }, 'Dubbele punten') : h('span', null, r.scoring || 'Snel én goed = meer punten')));
}
const byPid = () => Object.fromEntries(V.pl.map(p => [p.pid, p]));
function hostQuestion(revealed) {
  const q = V.q; const res = (revealed && V.res) || {};
  const wrap = h('section', { class: `qv qv-${q.type}${revealed ? ' is-rev' : ''}` });
  const prompt = h('div', { class: 'prompt' });
  if (q.type === 'who' && q.quote) prompt.append(h('p', { class: 'eyebrow' }, q.text || 'Wie zei het?'), h('blockquote', { class: 'quote' }, h('span', { class: 'qm', 'aria-hidden': 'true' }, '“'), q.quote, h('span', { class: 'qm qm-end', 'aria-hidden': 'true' }, '”')));
  else prompt.append(h('p', { class: 'eyebrow' }, q.type === 'num' ? 'Schatvraag · wie zit het dichtst bij?' : q.type === 'tf' ? 'Waar of niet waar?' : (q.kicker || V.round.title)), h('h1', { class: 'qtext' }, q.text));
  const body = q.type === 'num' ? (revealed ? numReveal(q, res) : numWaiting(q)) : optionsGrid(q, revealed ? res : null);
  if (!revealed) {
    wrap.append(prompt, body, h('div', { class: 'timer' }, h('div', { class: 'timer-track' }, h('i', { id: 't-bar' })), h('span', { class: 'timer-num', id: 't-num' }, String(Math.ceil(V.dur / 1000)))), answeredStrip());
  } else {
    wrap.append(h('div', { class: 'rev-main' }, prompt, body, q.note ? h('p', { class: 'note-line' }, q.note) : null), h('aside', { class: 'rev-side' }, gainsEl(q, res), manualEl(q, res)));
  }
  return wrap;
}
function optionsGrid(q, res) {
  const grid = h('div', { class: `opts n${q.options.length}` });
  const pickers = {}; const P = byPid();
  if (res) for (const [pid, v] of Object.entries(res)) if (v.a != null) (pickers[v.a] ||= []).push(pid);
  q.options.forEach((o, i) => {
    const correct = res && i === q.answer;
    const tile = h('div', { class: 'opt' + (res ? (correct ? ' correct' : ' dim') : ''), style: { '--c': o.color } });
    tile.append(o.kit ? kitSVG(o.color, o.kit, 'kit opt-kit') : h('span', { class: 'opt-shape' }, shapeSVG(o.shape)), h('span', { class: 'opt-label' }, o.label));
    if (res) {
      const list = pickers[i] || []; const pk = h('span', { class: 'pickers' });
      for (const pid of list) { const p = P[pid]; if (p) pk.append(h('span', { class: 'pick', style: { '--pc': p.c } }, p.n)); }
      tile.append(h('span', { class: 'opt-count' }, String(list.length)), pk);
      if (correct) tile.append(h('span', { class: 'opt-check', 'aria-label': 'Goed antwoord' }, '✓'));
    }
    grid.append(tile);
  });
  return grid;
}
function numWaiting(q) {
  return h('div', { class: 'num-wait' }, h('div', { class: 'num-box' }, h('span', { class: 'num-q' }, '?'), q.unit ? h('span', { class: 'num-unit' }, q.unit) : null),
    h('p', { class: 'num-hint' }, 'Typ je schatting op je telefoon. Dichtstbij wint 1000, tweede 600, derde 300. Precies goed: +500 bonus.'));
}
function numReveal(q, res) {
  const P = byPid();
  const rows = Object.entries(res).filter(([, v]) => v.a != null).map(([pid, v]) => ({ pid, ...v }));
  const box = h('div', { class: 'num-rev' }, h('div', { class: 'num-answer' }, h('span', { class: 'num-big' }, fmt(q.answer)), q.unit ? h('span', { class: 'num-unit' }, q.unit) : null));
  if (rows.length) {
    const vals = rows.map(r => r.a).concat(q.answer);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || Math.max(1, Math.abs(q.answer) * 0.2); lo -= span * 0.08; hi += span * 0.08;
    const pos = v => ((v - lo) / (hi - lo)) * 100;
    const line = h('div', { class: 'numline' }, h('div', { class: 'nl-axis' }), h('div', { class: 'nl-target', style: { left: pos(q.answer) + '%' } }, h('span', null, 'Antwoord')));
    const placed = [];
    [...rows].sort((a, b) => a.a - b.a).forEach(rw => {
      const p = P[rw.pid]; if (!p) return;
      const x = pos(rw.a); let tier = 0;
      while (tier < 4 && placed.some(o => o.tier === tier && Math.abs(o.x - x) < 10)) tier++;
      placed.push({ x, tier });
      line.append(h('div', { class: 'nl-dot', style: { left: x + '%', '--pc': p.c, '--tier': String(tier) } }, h('b', null, p.n), h('span', { class: 'v' }, fmt(rw.a)), h('i')));
    });
    box.append(line);
  } else box.append(h('p', { class: 'muted center' }, 'Niemand heeft een schatting ingestuurd.'));
  return box;
}
function answeredStrip() {
  const list = V.pl.filter(p => !p.off && p.on);
  const n = list.filter(p => p.done).length;
  return h('div', { class: 'answered', id: 'answered' }, h('span', { class: 'ans-count' }, list.length ? `${n}/${list.length} binnen` : 'Wachten op antwoorden'),
    ...list.map(p => h('span', { class: 'ans-p' + (p.done ? ' done' : '') }, kitSVG(p.done ? p.c : '#3A4884', p.k), h('span', null, p.n))));
}
function gainsEl(q, res) {
  const rows = V.pl.map(p => ({ p, g: res[p.pid]?.p || 0, ok: !!res[p.pid]?.ok, ms: res[p.pid]?.ms, man: !!res[p.pid]?.man, answered: !!res[p.pid], a: res[p.pid]?.a }));
  rows.sort((a, b) => b.g - a.g || b.p.score - a.p.score);
  const box = h('div', { class: 'gains' }, h('h3', null, 'Punten'));
  if (!rows.length) { box.append(h('p', { class: 'muted' }, 'Nog geen spelers.')); return box; }
  box.append(h('div', { class: 'gains-head', 'aria-hidden': 'true' }, h('span', null, 'deze vraag'), h('span', null, 'totaal')));
  const ul = h('ul');
  for (const r of rows) ul.append(h('li', { class: r.g ? 'plus' : (r.answered ? 'zero' : 'none') }, kitSVG(r.p.c, r.p.k),
    h('span', { class: 'gn' }, r.p.n, q.type === 'num' && r.a != null ? h('small', null, fmt(r.a)) : null),
    h('span', { class: 'gp' }, r.g ? `+${fmt(r.g)}` : (r.answered ? '0' : '—')), h('span', { class: 'gt' }, fmt(r.p.score))));
  box.append(ul);
  const fastest = q.type !== 'num' ? rows.filter(r => r.ok && !r.man && r.ms != null).sort((a, b) => a.ms - b.ms)[0] : null;
  if (fastest) box.append(h('p', { class: 'fastest' }, `Snelste goede antwoord: ${fastest.p.n} (${(fastest.ms / 1000).toFixed(1).replace('.', ',')} s)`));
  return box;
}
function manualEl(q, res) {
  const cands = V.pl.filter(p => p.off || !res[p.pid] || res[p.pid].man);
  if (!cands.length) return null;
  return h('div', { class: 'manual' }, h('h3', null, q.type === 'num' ? 'Handmatig: wie zat het dichtst bij?' : 'Handmatig: wie had het goed?'),
    h('div', { class: 'manual-row' }, ...cands.map(p => { const on = !!res[p.pid]?.man; return h('button', { class: 'mtoggle' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', style: { '--pc': p.c }, onclick: () => hostCmd('manual', { pid: p.pid }) }, on ? '✓ ' : '', p.n); })));
}
function hostBoard(final) {
  const before = V.before || {};
  const rank = (score) => 1 + V.pl.filter(p => p.score > score).length;
  const rows = [...V.pl].sort((a, b) => b.score - a.score || a.n.localeCompare(b.n, 'nl')).map(p => ({ ...p, rank: rank(p.score), prev: 1 + V.pl.filter(o => (before[o.pid] || 0) > (before[p.pid] || 0)).length }));
  const max = Math.max(1, ...rows.map(r => r.score));
  const wrap = h('section', { class: 'board' + (final ? ' is-final' : '') }, h('p', { class: 'eyebrow' }, final ? 'Eindstand' : `Tussenstand na ronde ${V.ri + 1}`));
  if (final && rows.length) {
    const winners = rows.filter(r => r.rank === 1);
    wrap.append(h('h1', { class: 'board-title' }, rows[0].score > 0 ? `${winners.map(r => r.n).join(' & ')} ${winners.length > 1 ? 'winnen' : 'wint'}!` : 'Eindstand'));
    const pod = h('div', { class: 'podium' });
    for (const r of [rows[1], rows[0], rows[2]].filter(Boolean)) pod.append(h('div', { class: `pod pod-${Math.min(r.rank, 3)}` }, kitSVG(r.c, r.k, 'kit pod-kit'), h('span', { class: 'pod-name' }, r.n), h('span', { class: 'pod-score' }, fmt(r.score)), h('div', { class: 'pod-step' }, h('span', null, String(r.rank)))));
    wrap.append(pod);
  } else wrap.append(h('h1', { class: 'board-title' }, final ? 'Eindstand' : 'Marcador'));
  const list = h('ol', { class: 'bd' });
  for (const r of final ? rows.slice(3) : rows) {
    const mv = r.prev - r.rank;
    list.append(h('li', { class: 'bd-row' }, h('span', { class: 'bd-rank' }, String(r.rank)), kitSVG(r.c, r.k), h('span', { class: 'bd-name' }, r.n),
      h('span', { class: 'bd-bar' }, h('i', { style: { '--pc': r.c, width: `${((before[r.pid] || 0) / max) * 100}%` }, 'data-w': `${(r.score / max) * 100}%` })),
      h('span', { class: 'bd-score' }, fmt(r.score)), h('span', { class: 'bd-move ' + (mv > 0 ? 'up' : mv < 0 ? 'down' : 'same') }, mv > 0 ? `▲${mv}` : mv < 0 ? `▼${-mv}` : '•')));
  }
  if (!rows.length) list.append(h('li', { class: 'muted' }, 'Geen spelers in dit spel.'));
  wrap.append(list);
  return wrap;
}
function tickHost() {
  if (!V || !IS_SCREEN) return;
  const now = serverNow();
  if (V.ph === 'q') {
    const left = V.t0 + V.dur - now;
    const bar = $('#t-bar'), num = $('#t-num');
    if (bar && num) {
      bar.style.transform = `scaleX(${clamp(left / V.dur, 0, 1)})`; bar.classList.toggle('low', left < 5500);
      const sec = Math.max(0, Math.ceil(left / 1000)); num.textContent = String(sec); num.classList.toggle('low', left < 5500);
      if (sec !== host.lastSec) { host.lastSec = sec; if (sec <= 5 && sec > 0) Sound.play('tick'); }
    }
  }
  const hint = $('#auto-hint');
  if (hint) {
    let text = '';
    if (V.ph === 'lobby') text = 'Spatie of → = volgende';
    else if (V.paused) text = 'Gepauzeerd';
    else if (V.auto && V.wakeAt && V.ph !== 'q') { const s = Math.max(0, Math.ceil((V.wakeAt - now) / 1000)); text = `${V.ph === 'rev' ? (V.qi + 1 < V.round.n ? 'Volgende vraag' : 'Stand') : V.ph === 'board' ? 'Volgende ronde' : 'Eerste vraag'} over ${s} s`; }
    if (hint.textContent !== text) hint.textContent = text;
  }
}
document.addEventListener('keydown', e => {
  if (!IS_SCREEN || !V || needKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
  if (e.key === 'Escape') { if (host.confirmReset || host.menuOpen) { host.confirmReset = false; host.menuOpen = false; renderHost(); } return; }
  if (host.confirmReset) return;
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
    if (e.target && e.target.tagName === 'BUTTON' && e.key !== 'ArrowRight') return;
    e.preventDefault(); if (primaryLabel() && V.ph !== 'end') hostCmd(V.ph === 'q' ? 'reveal' : 'next');
  } else if (e.key === 'p' || e.key === 'P') { if (V.ph !== 'lobby' && V.ph !== 'end') hostCmd(V.paused ? 'resume' : 'pause'); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'm' || e.key === 'M') { Sound.on = !Sound.on; lsSet('mq.sound', Sound.on); renderHost(); }
});
document.addEventListener('click', () => Sound.wake(), { once: true });

/* ---------- phone ---------- */
let pCustom = false, pEdit = false;
function renderPlayer(force) {
  app.dataset.view = 'player';
  const q = V && (V.ph === 'q' || V.ph === 'rev') ? V.q : null;
  const answered = !!(q && (V.mine != null || pending[q.id] != null));
  const late = !!(V && V.ph === 'q' && serverNow() > V.t0 + V.dur);
  const key = [online, !!V, V && V.game, V && V.ph, V && V.ri, V && V.qi, !!(V && V.me), pEdit, pCustom, answered, late, V && (V.ph === 'rev' || V.ph === 'board' || V.ph === 'end') ? V.score : ''].join('|');
  if (!force && key === lastKey) { softRefreshPlayer(); return; }
  lastKey = key;
  const wrap = h('div', { class: 'phone' }, playerHead());
  const body = h('main', { class: 'p-body' });
  if (!V) body.append(online ? pWait('Wachten op het grote scherm…', 'Staat de quiz open op de laptop of tv? Dan verschijn je hier vanzelf.') : pWait('Verbinden…', 'We maken verbinding met de quiz.'));
  else if (!V.me || pEdit) body.append(playerJoinEl());
  else if (V.ph === 'lobby') body.append(playerLobby());
  else if (V.ph === 'intro') body.append(pWait(`Ronde ${V.ri + 1}: ${V.round.title}`, V.round.blurb, 'Kijk naar het grote scherm'));
  else if (V.ph === 'q') body.append(playerQuestion(q, late));
  else if (V.ph === 'rev') body.append(playerReveal(q));
  else body.append(playerStanding(V.ph === 'end'));
  wrap.append(body);
  const typed = $('#p-name') ? $('#p-name').value : null;
  app.replaceChildren(wrap);
  if (typed != null && $('#p-name')) $('#p-name').value = typed;
  tickPlayer();
}
function softRefreshPlayer() {
  const sc = $('#p-score'); if (sc && V && V.score != null) sc.textContent = fmt(V.score);
  const ul = $('#p-roster'); if (ul) ul.replaceWith(playerRosterEl());
  const taken = new Set((V && V.taken) || []);
  document.querySelectorAll('.p-person').forEach(b => { const t = taken.has((b.dataset.name || '').toLowerCase()); b.disabled = t; const s = b.querySelector('small'); if (s) s.hidden = !t; });
  tickPlayer();
}
function playerHead() {
  const head = h('header', { class: 'p-head' }, wordmark());
  if (V && V.me) head.append(h('button', { class: 'p-me', onclick: () => { pEdit = true; renderPlayer(true); }, title: 'Naam wijzigen' }, kitSVG(V.me.c, V.me.k), h('span', null, V.me.n), h('b', { id: 'p-score' }, V.score != null ? fmt(V.score) : '')));
  return head;
}
function pWait(title, text, kicker) {
  return h('div', { class: 'p-card p-wait' }, kicker ? h('p', { class: 'eyebrow' }, kicker) : null, h('h2', null, title), text ? h('p', null, text) : null, h('div', { class: 'p-ball', 'aria-hidden': 'true', html: SUN }));
}
function join(name, person) {
  Sound.wake();
  const n = String(name || '').trim().slice(0, 18); if (!n) { toast('Typ eerst je naam'); return; }
  const color = person ? person.color : EXTRA_COLORS[[...PID].reduce((a, ch) => a + ch.charCodeAt(0), 0) % EXTRA_COLORS.length];
  const me = { n, c: color, k: person ? person.kit : n.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() };
  lsSet('mq.me', me); lsSet('mq.room', ROOM);
  pEdit = false; pCustom = false;
  send({ type: 'hello', ...me });
  keepAwake();
}
function playerJoinEl() {
  const taken = new Set(V.taken || []);
  const last = lsGet('mq.me', null);
  const card = h('div', { class: 'p-card p-join' }, h('p', { class: 'eyebrow' }, V.me ? 'Naam wijzigen' : `Quiz ${ROOM} · geen account nodig`), h('h2', null, 'Wie ben jij?'));
  const grid = h('div', { class: 'p-people' });
  for (const p of PEOPLE) {
    const isTaken = taken.has(p.name.toLowerCase());
    grid.append(h('button', { class: 'p-person' + (last && last.n === p.name ? ' last' : ''), 'data-name': p.name, style: { '--c': p.color }, disabled: isTaken, onclick: () => join(p.name, p) },
      kitSVG(p.color, p.kit), h('span', null, p.name, h('small', { hidden: !isTaken }, 'al binnen'))));
  }
  card.append(grid);
  if (!pCustom) card.append(h('button', { class: 'linkish', onclick: () => { pCustom = true; renderPlayer(true); setTimeout(() => $('#p-name')?.focus(), 0); } }, 'Iemand anders? Typ je eigen naam'));
  else {
    const input = h('input', { id: 'p-name', class: 'field', maxlength: '18', placeholder: 'Jouw naam', autocomplete: 'nickname', enterkeyhint: 'go' });
    card.append(h('form', { class: 'p-custom', onsubmit: e => { e.preventDefault(); join(input.value, null); } }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Doe mee')));
  }
  if (V.me) card.append(h('button', { class: 'linkish', onclick: () => { pEdit = false; renderPlayer(true); } }, 'Terug'));
  return card;
}
function playerLobby() {
  return h('div', { class: 'p-card' }, h('p', { class: 'eyebrow' }, 'Je staat in de opstelling'), h('h2', null, `Klaar voor de aftrap, ${V.me.n}?`),
    h('p', null, 'De quiz start zo. Houd dit scherm open; de vragen verschijnen vanzelf.'), playerRosterEl());
}
function playerRosterEl() {
  const ul = h('ul', { class: 'p-roster', id: 'p-roster' });
  for (const p of (V && V.roster) || []) ul.append(h('li', { class: p.me ? 'me' : '' }, kitSVG(p.c, p.k), h('span', null, p.n)));
  return ul;
}
function parseNum(s) {
  let t = String(s || '').trim().replace(/\s/g, '').replace(/[€$]/g, '');
  if (!t) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.'); const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
function answer(q, a) {
  if (pending[q.id] != null || V.mine != null) return;
  pending[q.id] = a;
  if (navigator.vibrate) try { navigator.vibrate(30); } catch { /* not supported */ }
  send({ type: 'answer', q: q.id, a });
  renderPlayer(true);
}
function playerQuestion(q, late) {
  const card = h('div', { class: 'p-card p-q' }, h('div', { class: 'p-timer' }, h('i', { id: 'p-tbar' })), h('p', { class: 'eyebrow' }, `${V.round.title} · vraag ${V.qi + 1}/${V.round.n}`));
  if (q.type === 'who' && q.quote) card.append(h('blockquote', { class: 'p-quote' }, `“${q.quote}”`));
  else card.append(h('h2', { class: 'p-qtext' }, q.text));
  const mine = V.mine != null ? V.mine : pending[q.id];
  if (mine != null) {
    const label = q.type === 'num' ? fmt(mine) + (q.unit ? ' ' + q.unit : '') : q.options[mine]?.label;
    card.append(h('div', { class: 'p-sent' }, h('span', { class: 'p-sent-check' }, '✓'), h('div', null, h('b', null, V.mine != null ? 'Ingestuurd' : 'Versturen…'), h('span', null, label))), h('p', { class: 'muted center' }, 'Wacht op het antwoord op het grote scherm.'));
    return card;
  }
  if (q.type === 'num') {
    const input = h('input', { id: 'p-num', class: 'field field-num', inputmode: 'decimal', autocomplete: 'off', placeholder: q.unit ? `Aantal ${q.unit}` : 'Jouw schatting', enterkeyhint: 'send' });
    const err = h('p', { class: 'p-err', role: 'alert' });
    card.append(h('form', { class: 'p-numform', onsubmit: e => { e.preventDefault(); const v = parseNum(input.value); if (v == null) { err.textContent = 'Typ een getal, bijvoorbeeld 1250'; return; } answer(q, v); } },
      input, h('button', { class: 'btn btn-primary btn-wide', type: 'submit', disabled: late }, 'Insturen'), err));
    setTimeout(() => { const i = $('#p-num'); if (i && document.activeElement !== i) i.focus(); }, 50);
  } else {
    const grid = h('div', { class: `p-opts n${q.options.length}` });
    q.options.forEach((o, i) => grid.append(h('button', { class: 'p-opt', style: { '--c': o.color }, disabled: late, onclick: () => answer(q, i) }, o.kit ? kitSVG(o.color, o.kit) : h('span', { class: 'opt-shape' }, shapeSVG(o.shape)), h('span', null, o.label))));
    card.append(grid);
  }
  if (late) card.append(h('p', { class: 'muted center' }, 'De tijd is om.'));
  return card;
}
function playerReveal(q) {
  const res = V.res; const mine = V.mine; const pts = res ? res.p : null;
  const card = h('div', { class: 'p-card p-rev' });
  if (q.type === 'num') {
    if (mine == null && !(pts > 0)) card.append(h('div', { class: 'p-verdict none' }, 'Geen schatting'));
    else if (mine != null) {
      const diff = Math.abs(mine - q.answer);
      card.append(h('div', { class: 'p-verdict ' + (pts > 0 ? 'good' : 'bad') }, pts > 0 ? (diff === 0 ? '¡Precies goed!' : (res.r === 1 ? '¡Olé! Dichtstbij' : 'In de buurt!')) : 'Ernaast'),
        h('p', { class: 'p-detail' }, diff === 0 ? 'Je had het exacte getal.' : `Je zat er ${fmt(Math.round(diff * 100) / 100)} naast.`));
    } else card.append(h('div', { class: 'p-verdict good' }, 'Punten van de quizmaster'));
    card.append(h('p', { class: 'p-answer' }, 'Het juiste antwoord: ', h('b', null, fmt(q.answer) + (q.unit ? ' ' + q.unit : ''))));
  } else {
    const good = (mine != null && mine === q.answer) || pts > 0;
    card.append(mine == null && !(pts > 0) ? h('div', { class: 'p-verdict none' }, 'Niet geantwoord') : h('div', { class: 'p-verdict ' + (good ? 'good' : 'bad') }, good ? '¡Olé! Goed' : 'Helaas, fout'),
      h('p', { class: 'p-answer' }, 'Het juiste antwoord: ', h('b', null, q.options[q.answer].label)));
  }
  if (pts != null) card.append(h('p', { class: 'p-points' }, pts > 0 ? `+${fmt(pts)} punten` : '0 punten'));
  if (V.rank) card.append(h('p', { class: 'p-rank' }, `Je staat #${V.rank} van ${V.of} met ${fmt(V.score)} punten`));
  if (q.note) card.append(h('p', { class: 'p-note' }, q.note));
  return card;
}
function playerStanding(final) {
  const card = h('div', { class: 'p-card p-stand' }, h('p', { class: 'eyebrow' }, final ? 'Eindstand' : `Tussenstand na ronde ${V.ri + 1}`));
  if (V.rank) {
    const medal = final ? (V.rank === 1 ? 'Kampioen!' : V.rank === 2 ? 'Zilver!' : V.rank === 3 ? 'Brons!' : 'Gespeeld!') : null;
    card.append(h('div', { class: 'p-bigrank' }, h('span', null, '#'), String(V.rank)), h('h2', null, medal || `Plek ${V.rank} van ${V.of}`), h('p', null, `${fmt(V.score)} punten`));
  } else card.append(h('h2', null, 'Kijk naar het grote scherm'));
  return card;
}
function tickPlayer() {
  const bar = $('#p-tbar'); if (!bar || !V || V.ph !== 'q') return;
  const left = V.t0 + V.dur - serverNow();
  bar.style.transform = `scaleX(${clamp(left / V.dur, 0, 1)})`; bar.classList.toggle('low', left < 5500);
  if (left <= 0 && !bar.dataset.done) { bar.dataset.done = '1'; renderPlayer(true); }
}
setInterval(() => { if (!ROOM || needKey) return; if (IS_SCREEN) tickHost(); else tickPlayer(); }, 200);

/* ---------- boot ---------- */
if (!ROOM) render();
else if (IS_SCREEN) { lsSet('mq.lastScreen', ROOM); bootScreen(); }
else bootPhone();
})();
