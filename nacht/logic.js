/**
 * Última Ronda — the rules. Pure and deterministic: time arrives as `action.at` and the
 * connected player ids as `action.online`, both stamped by the big screen (the quiz master).
 * Phases: lobby → intro → q → rev → (q → rev)… → board → intro … → end.
 */
window.MDQ_makeLogic = function (RAW_ROUNDS) {
'use strict';
const meta = { game: 'Última Ronda', minPlayers: 1, maxPlayers: 64 };

const PEOPLE = [
  { id: 'jasper', name: 'Jasper', kit: 'JA', color: '#FF7A6B' },
  { id: 'bart', name: 'Bart', kit: 'BA', color: '#4CB8FF' },
  { id: 'daan', name: 'Daan', kit: 'DA', color: '#FFD24A' },
  { id: 'pepijn', name: 'Pepijn', kit: 'PE', color: '#3EDB9B' },
  { id: 'stijn', name: 'Stijn', kit: 'ST', color: '#B48CFF' },
  { id: 'benoit', name: 'Benoît', kit: 'BE', color: '#FF8FC7' },
];
const OPT_COLORS = ['#FF5D73', '#3FA9F5', '#FFC93C', '#B98BFF'];
const OPT_SHAPES = ['tri', 'dia', 'dot', 'sq'];
const TYPE_DUR = { who: 20, mc: 20, tf: 15, num: 30, poll: 20 };
/** How long the reveal / standings / round intro stay up before auto-advance (ms, × tempo). */
const HOLD = { rev: 13000, revNum: 16000, board: 12000, intro: 8000 };
/** An answer that arrives this long after the clock ran out is still accepted (network lag). */
const GRACE = 1500;
const MAX_PLAYERS = 40;



const ROUNDS = RAW_ROUNDS.map(r => ({
  id: r.id, title: r.title, blurb: r.blurb, scoring: r.scoring || '', mult: r.mult || 1,
  questions: r.questions.map((q, qi) => normalizeQ(q, r, qi)),
}));

function normalizeQ(q, r, qi) {
  const base = { ...q, id: `${r.id}q${qi + 1}`, dur: q.dur || TYPE_DUR[q.type] || 20 };
  if (q.type === 'who') {
    return { ...base, options: PEOPLE.map(p => ({ label: p.name, color: p.color, kit: p.kit })), answer: PEOPLE.findIndex(p => p.id === q.who) };
  }
  if (q.type === 'tf') {
    return { ...base, options: [{ label: 'Waar', color: '#39D98A', shape: 'dot' }, { label: 'Niet waar', color: '#FF5D73', shape: 'sq' }], answer: q.answer ? 0 : 1 };
  }
  if (q.type === 'poll') {
    const options = q.people ? PEOPLE.map(p => ({ label: p.name, color: p.color, kit: p.kit })) : q.options.map((o, i) => ({ label: o, color: OPT_COLORS[i % 4], shape: OPT_SHAPES[i % 4] }));
    return { ...base, options, answer: null };
  }
  if (q.type === 'mc') {
    return { ...base, options: q.options.map((o, i) => ({ label: o, color: OPT_COLORS[i % 4], shape: OPT_SHAPES[i % 4] })) };
  }
  return base; // num
}

/* ---------- small helpers ---------- */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round10 = x => Math.round(x / 10) * 10;
const OK = { ok: true };
const no = error => ({ ok: false, error });
const CC = String.fromCharCode;
const CTRL_RE = new RegExp('[' + CC(0) + '-' + CC(31) + CC(127) + CC(0x200b) + '-' + CC(0x200f) + CC(0x2028) + '-' + CC(0x202e) + CC(0x2060) + '-' + CC(0x2064) + CC(0xfeff) + ']', 'g');
function cleanName(n) { return typeof n === 'string' ? n.replace(CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 18) : ''; }
function cleanColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#A7B1D8'; }
function cleanKit(k, n) {
  const s = (typeof k === 'string' ? k : '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  return s || (cleanName(n).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '??');
}
const roundOf = (S, ri = S.ri) => ROUNDS[S.plan[ri]] || null;
const qOf = S => { if (S.ph === 'lobby' || S.ph === 'end') return null; const r = roundOf(S); return r ? r.questions[S.qi] || null : null; };
const onlineSet = S => new Set(S.online || []);
const activePids = S => { const on = onlineSet(S); return Object.keys(S.pl).filter(p => !S.pl[p].off && on.has(p)); };

function validAnswer(q, a) {
  if (q.type === 'num') return typeof a === 'number' && Number.isFinite(a) && Math.abs(a) < 1e12;
  return Number.isInteger(a) && a >= 0 && a < q.options.length;
}

/* ---------- scoring ---------- */
function scoreQuestion(q, answers, dur, mult) {
  const out = {};
  if (q.type === 'poll') {
    // herd instinct: no right answer, you score when you picked (one of) the most chosen option(s)
    const votes = {};
    for (const v of Object.values(answers)) votes[v.a] = (votes[v.a] || 0) + 1;
    const max = Math.max(0, ...Object.values(votes));
    for (const [pid, v] of Object.entries(answers)) {
      const ok = max > 0 && votes[v.a] === max;
      out[pid] = { a: v.a, ms: v.ms, ok, p: ok ? round10(750 * mult) : 0 };
    }
    return out;
  }
  if (q.type === 'num') {
    const list = Object.entries(answers).map(([pid, v]) => ({ pid, a: v.a, ms: v.ms, err: Math.abs(v.a - q.answer) }));
    list.sort((x, y) => x.err - y.err || x.ms - y.ms);
    let rank = 0, prev = null;
    list.forEach((it, i) => { if (it.err !== prev) { rank = i + 1; prev = it.err; } it.rank = rank; });
    const table = [1000, 600, 300];
    for (const it of list) {
      let p = table[it.rank - 1] || 0;
      if (it.err === 0) p += 500;
      out[it.pid] = { a: it.a, ms: it.ms, p: round10(p * mult), r: it.rank, ok: it.rank === 1 };
    }
  } else {
    for (const [pid, v] of Object.entries(answers)) {
      const ok = v.a === q.answer;
      const frac = clamp(v.ms / dur, 0, 1);
      out[pid] = { a: v.a, ms: v.ms, ok, p: ok ? round10((500 + 500 * (1 - frac)) * mult) : 0 };
    }
  }
  return out;
}
function totals(S, only) {
  const t = {};
  for (const pid of Object.keys(S.pl)) t[pid] = 0;
  for (const [qid, r] of Object.entries(S.res || {})) {
    if (only && !only.has(qid)) continue;
    for (const [pid, v] of Object.entries(r)) if (pid in t) t[pid] += v.p || 0;
  }
  return t;
}
function idsBefore(S, riLimit) {
  const set = new Set();
  for (let i = 0; i < riLimit; i++) { const r = roundOf(S, i); if (r) for (const q of r.questions) set.add(q.id); }
  return set;
}

/* ---------- state ---------- */
function fresh(prev, at) {
  const pl = {};
  if (prev && prev.pl) for (const [pid, p] of Object.entries(prev.pl)) pl[pid] = { n: p.n, c: p.c, k: p.k, off: !!p.off, j: p.j || 0 };
  return {
    v: 1, game: ((prev && prev.game) || 0) + 1, ph: 'lobby', ri: 0, qi: 0,
    plan: prev && Array.isArray(prev.plan) ? prev.plan.filter(i => ROUNDS[i]) : ROUNDS.map((_, i) => i),
    speed: (prev && prev.speed) || 1, auto: prev ? prev.auto !== false : true, paused: false,
    t0: 0, dur: 0, phAt: at || 0, wakeAt: null,
    pl, res: {}, ans: {}, online: (prev && prev.online) || [],
  };
}

function setup() { return fresh(null, 0); }

function validateAction(state, playerId, action) {
  const S = state;
  if (!isObj(S) || !isObj(action) || typeof action.type !== 'string') return no('Onbekende actie');
  const t = action.type;
  if (t === 'tick' || t === 'presence') return playerId === '__clock' ? OK : no('Alleen de klok mag dat');
  if (typeof playerId !== 'string' || playerId.startsWith('__')) return no('Ongeldige speler');
  if (t === 'hello') {
    if (playerId.startsWith('scr_')) return no('Het grote scherm speelt niet mee');
    if (!cleanName(action.n)) return no('Kies of typ een naam');
    if (!S.pl[playerId] && Object.keys(S.pl).length >= MAX_PLAYERS) return no('De quiz zit vol');
    return OK;
  }
  if (t === 'answer') {
    if (S.ph !== 'q') return no('Er staat nu geen vraag open');
    const q = qOf(S);
    if (!q || action.q !== q.id) return no('Deze vraag is al voorbij');
    if (!S.pl[playerId]) return no('Meld je eerst aan');
    if (S.ans[playerId]) return no('Je hebt al geantwoord');
    if (!validAnswer(q, action.a)) return no('Dat antwoord snap ik niet');
    if (typeof action.at === 'number' && action.at > S.t0 + S.dur + GRACE) return no('De tijd is om');
    return OK;
  }
  if (t === 'host') {
    if (!playerId.startsWith('scr_')) return no('Dat kan alleen vanaf het grote scherm');
    const c = action.cmd;
    const known = ['next', 'reveal', 'pause', 'resume', 'auto', 'reset', 'plan', 'speed', 'addOffline', 'remove', 'manual', 'skipRound'];
    if (!known.includes(c)) return no('Onbekende opdracht');
    if (c === 'plan' && (S.ph !== 'lobby' || !(Number.isInteger(action.i) && action.i >= 0 && action.i < ROUNDS.length))) return no('Rondes kies je in de lobby');
    if (c === 'speed' && ![0.75, 1, 1.5].includes(action.v)) return no('Onbekend tempo');
    if (c === 'auto' && typeof action.on !== 'boolean') return no('Aan of uit?');
    if (c === 'addOffline' && !cleanName(action.n)) return no('Typ een naam');
    if (c === 'addOffline' && Object.keys(S.pl).length >= MAX_PLAYERS) return no('De quiz zit vol');
    if ((c === 'remove' || c === 'manual') && !(typeof action.pid === 'string' && S.pl[action.pid])) return no('Onbekende speler');
    if (c === 'manual' && S.ph !== 'rev') return no('Punten geef je na het antwoord');
    if (c === 'next' && S.ph === 'lobby' && !S.plan.length) return no('Kies minstens één ronde');
    return OK;
  }
  return no('Onbekende actie');
}

function applyAction(state, playerId, action) {
  const S = clone(state);
  const at = typeof action.at === 'number' ? action.at : S.phAt;
  if (Array.isArray(action.online)) S.online = action.online.filter(x => typeof x === 'string').slice(0, 200);
  switch (action.type) {
    case 'presence': break;
    case 'tick': if (S.wakeAt != null && at >= S.wakeAt) advance(S, at); break;
    case 'hello': register(S, playerId, action, at); break;
    case 'answer': S.ans[playerId] = { a: action.a, ms: clamp(at - S.t0, 0, S.dur) }; break;
    case 'host': host(S, action, at); break;
    default: break;
  }
  // everyone with a phone has answered: no need to wait for the clock
  if (S.ph === 'q') {
    const act = activePids(S);
    if (act.length && act.every(p => S.ans[p])) reveal(S, at);
  }
  S.wakeAt = wakeOf(S);
  return S;
}

function register(S, pid, action, at) {
  const n = cleanName(action.n), c = cleanColor(action.c), k = cleanKit(action.k, n);
  if (S.pl[pid]) { Object.assign(S.pl[pid], { n, c, k, off: false }); return; }
  // same name as someone who is not connected now (new phone, cleared browser, or a player
  // without a phone who picked one up): carry their points over to this device
  const on = onlineSet(S);
  const twin = Object.keys(S.pl).find(o => o !== pid && !on.has(o) && S.pl[o].n.toLowerCase() === n.toLowerCase());
  if (twin) {
    S.pl[pid] = { ...S.pl[twin], n, c, k, off: false };
    delete S.pl[twin];
    for (const r of Object.values(S.res)) if (r[twin]) { r[pid] = r[twin]; delete r[twin]; }
    if (S.ans[twin]) { S.ans[pid] = S.ans[twin]; delete S.ans[twin]; }
  } else S.pl[pid] = { n, c, k, j: at };
}

function startQ(S, at, qi) {
  S.ph = 'q'; S.qi = qi; S.t0 = at; S.phAt = at; S.ans = {};
  const q = roundOf(S).questions[qi];
  S.dur = Math.round(q.dur * 1000 * (S.speed || 1));
  delete S.res[q.id];
}
function reveal(S, at) {
  const q = qOf(S); const r = roundOf(S);
  if (!q) return;
  const prev = S.res[q.id] || {};
  const res = scoreQuestion(q, S.ans, S.dur, r.mult);
  for (const [pid, v] of Object.entries(prev)) if (v.man && !res[pid]) res[pid] = v;
  S.res[q.id] = res; S.ans = {}; S.ph = 'rev'; S.phAt = at;
}
function endRound(S, at) { S.ph = S.ri + 1 < S.plan.length ? 'board' : 'end'; S.phAt = at; S.ans = {}; }
function advance(S, at) {
  if (S.ph === 'q') return reveal(S, at);
  if (S.ph === 'intro') return startQ(S, at, 0);
  if (S.ph === 'rev') {
    const r = roundOf(S);
    if (S.qi + 1 < r.questions.length) return startQ(S, at, S.qi + 1);
    return endRound(S, at);
  }
  if (S.ph === 'board') {
    if (S.ri + 1 < S.plan.length) { S.ri++; S.qi = 0; S.ph = 'intro'; } else S.ph = 'end';
    S.phAt = at;
  }
}
function host(S, a, at) {
  switch (a.cmd) {
    case 'next':
      if (S.ph === 'lobby') { S.ph = 'intro'; S.ri = 0; S.qi = 0; S.phAt = at; S.paused = false; }
      else if (S.ph !== 'end') advance(S, at);
      break;
    case 'reveal': if (S.ph === 'q') reveal(S, at); break;
    case 'pause': S.paused = true; break;
    case 'resume': S.paused = false; S.phAt = at; break;
    case 'auto': S.auto = a.on; S.phAt = at; break;
    case 'skipRound': if (S.ph === 'intro' || S.ph === 'q' || S.ph === 'rev') endRound(S, at); break;
    case 'reset': {
      const on = onlineSet(S);
      const F = fresh(S, at);
      for (const pid of Object.keys(F.pl)) if (!F.pl[pid].off && !on.has(pid)) delete F.pl[pid];
      for (const k of Object.keys(S)) delete S[k];
      Object.assign(S, F);
      break;
    }
    case 'plan': {
      const set = new Set(S.plan);
      if (set.has(a.i)) set.delete(a.i); else set.add(a.i);
      S.plan = ROUNDS.map((_, i) => i).filter(i => set.has(i));
      break;
    }
    case 'speed': S.speed = a.v; break;
    case 'addOffline': {
      const n = cleanName(a.n);
      const person = PEOPLE.find(p => p.name.toLowerCase() === n.toLowerCase());
      const used = new Set(Object.values(S.pl).map(p => p.c));
      const extra = ['#7DD3FC', '#FDBA74', '#A3E635', '#F9A8D4', '#67E8F9', '#FCD34D', '#C4B5FD', '#86EFAC'];
      let id = 'off-' + n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) + '-' + Object.keys(S.pl).length;
      while (S.pl[id]) id += 'x';
      S.pl[id] = { n, c: person ? person.color : (extra.find(x => !used.has(x)) || extra[0]), k: person ? person.kit : cleanKit('', n), off: true, j: at };
      break;
    }
    case 'remove': {
      delete S.pl[a.pid]; delete S.ans[a.pid];
      for (const r of Object.values(S.res)) delete r[a.pid];
      break;
    }
    case 'manual': {
      const q = qOf(S); const r = roundOf(S);
      const res = S.res[q.id] || (S.res[q.id] = {});
      if (res[a.pid] && res[a.pid].man) delete res[a.pid];
      else if (!res[a.pid]) res[a.pid] = { a: null, ms: 0, ok: true, man: true, p: round10((q.type === 'num' ? 1000 : 750) * r.mult) };
      break;
    }
    default: break;
  }
}
function wakeOf(S) {
  const sp = S.speed || 1;
  if (S.ph === 'q') return S.t0 + S.dur + 300;
  if (!S.auto || S.paused) return null;
  if (S.ph === 'rev') { const q = qOf(S); return S.phAt + Math.round((q && q.type === 'num' ? HOLD.revNum : HOLD.rev) * sp); }
  if (S.ph === 'board') return S.phAt + Math.round(HOLD.board * sp);
  if (S.ph === 'intro') return S.phAt + Math.round(HOLD.intro * sp);
  return null;
}

function isGameOver() { return { over: false }; }

/* ---------- views: each client receives only what it may see ---------- */
function pollWinners(res) {
  const votes = {};
  for (const v of Object.values(res || {})) if (v && v.a != null) votes[v.a] = (votes[v.a] || 0) + 1;
  const max = Math.max(0, ...Object.values(votes));
  return max ? Object.keys(votes).filter(k => votes[k] === max).map(Number).sort((a, b) => a - b) : [];
}
function publicQ(q, withAnswer) {
  const o = { id: q.id, type: q.type, text: q.text || null, quote: q.quote || null, kicker: q.kicker || null, unit: q.unit || null, options: q.options || null, dur: q.dur };
  if (withAnswer) { o.answer = q.answer; o.note = q.note || null; }
  return o;
}
function viewFor(state, playerId) {
  const S = state;
  if (!isObj(S) || S.v !== 1) return null;
  const t = totals(S);
  const r = roundOf(S); const q = qOf(S);
  const on = onlineSet(S);
  const base = {
    game: S.game, ph: S.ph, ri: S.ri, qi: S.qi, nr: S.plan.length, t0: S.t0, dur: S.dur, phAt: S.phAt,
    wakeAt: S.wakeAt, auto: S.auto, paused: S.paused, speed: S.speed,
    round: r ? { title: r.title, blurb: r.blurb, scoring: r.scoring, mult: r.mult, n: r.questions.length } : null,
    q: q ? publicQ(q, S.ph === 'rev') : null,
  };
  if (q && q.type === 'poll' && S.ph === 'rev') base.q.answer = pollWinners(S.res[q.id]);
  if (typeof playerId === 'string' && playerId.startsWith('scr_')) {
    const view = {
      role: 'screen', ...base, plan: S.plan,
      rounds: ROUNDS.map(x => ({ title: x.title, n: x.questions.length, mult: x.mult, secs: x.questions.reduce((s, qq) => s + qq.dur, 0) })),
      pl: Object.keys(S.pl).map(p => ({ pid: p, n: S.pl[p].n, c: S.pl[p].c, k: S.pl[p].k, off: !!S.pl[p].off, j: S.pl[p].j || 0, on: on.has(p), score: t[p] || 0, done: S.ph === 'q' && !!S.ans[p] })),
    };
    if (S.ph === 'rev' && q) view.res = S.res[q.id] || {};
    if (S.ph === 'board' || S.ph === 'end') view.before = totals(S, idsBefore(S, S.ri));
    return view;
  }
  const mine = S.pl[playerId];
  const scores = Object.keys(S.pl).map(p => t[p] || 0);
  const score = mine ? t[playerId] || 0 : null;
  const view = {
    role: 'player', ...base,
    me: mine ? { n: mine.n, c: mine.c, k: mine.k } : null,
    score, rank: mine ? 1 + scores.filter(v => v > score).length : null, of: scores.length,
    taken: Object.keys(S.pl).filter(p => p !== playerId && on.has(p)).map(p => S.pl[p].n.toLowerCase()),
    roster: Object.keys(S.pl).filter(p => on.has(p) || S.pl[p].off).slice(0, MAX_PLAYERS).map(p => ({ n: S.pl[p].n, c: S.pl[p].c, k: S.pl[p].k, me: p === playerId })),
  };
  if (q && S.ph === 'q') view.mine = S.ans[playerId] ? S.ans[playerId].a : null;
  if (q && S.ph === 'rev') { const rr = (S.res[q.id] || {})[playerId] || null; view.mine = rr ? rr.a : null; view.res = rr; }
  return view;
}

return { meta, setup, validateAction, applyAction, isGameOver, viewFor };
};
