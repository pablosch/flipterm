const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 7177;
const BOT_MS = +process.env.BOT_MS || 700;
const BOT_NAMES = ['hal9000', 'glados', 'skynet', 'wopr', 'deepblue'];
const conns = new Map();
const nicks = new Map();
const tables = new Map();

function newTable(name) {
  return {
    name,
    phase: 'lobby', // lobby | between | dealing | playing | over
    players: [],
    deck: [], discard: [],
    round: 0, first: -1, turn: 0,
    tasks: [], pending: null, timer: null,
  };
}

function findSeat(id) {
  for (const t of tables.values()) {
    const p = t.players.find(x => x.id === id);
    if (p) return { t, p };
  }
  return null;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  const d = [{ t: 'n', v: 0 }];
  for (let v = 1; v <= 12; v++) for (let i = 0; i < v; i++) d.push({ t: 'n', v });
  for (const m of [2, 4, 6, 8, 10]) d.push({ t: 'mod', v: m });
  d.push({ t: 'x2' });
  for (let i = 0; i < 3; i++) d.push({ t: 'freeze' }, { t: 'flip3' }, { t: 'sc' });
  return d;
}

function cardLabel(c) {
  if (c.t === 'n') return String(c.v);
  if (c.t === 'mod') return '+' + c.v;
  if (c.t === 'x2') return 'x2';
  return { freeze: 'FREEZE', flip3: 'FLIP3', sc: 'SC' }[c.t];
}

function sendTo(id, msg) {
  const res = conns.get(id);
  if (res) { try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} }
}
function lineId(id, text, cls) { sendTo(id, { type: 'line', text, cls }); }
function line(t, text, cls) { t.players.forEach(p => lineId(p.id, text, cls)); }
function lineTo(p, text, cls) { lineId(p.id, text, cls); }

const actives = t => t.players.filter(p => p.status === 'active');

function draw(t) {
  if (!t.deck.length) {
    if (!t.discard.length) return null;
    t.deck = shuffle(t.discard);
    t.discard = [];
    line(t, '· deck ran out: reshuffling the discard pile ·', 'sys');
  }
  return t.deck.pop();
}

function computeScore(p) {
  if (p.status === 'busted') return 0;
  let s = p.cards.reduce((a, c) => a + c.v, 0);
  if (p.mods.some(m => m.t === 'x2')) s *= 2;
  s += p.mods.filter(m => m.t === 'mod').reduce((a, m) => a + m.v, 0);
  if (p.flip7) s += 15;
  return s;
}

function tableLines(t) {
  const L = [];
  L.push(`── ${t.name} · round ${t.round} · deck ${t.deck.length} ──`);
  t.players.forEach((p, i) => {
    const mark = t.phase === 'playing' && i === t.turn && p.status === 'active' ? '▶' : ' ';
    const hand = [...p.cards.map(cardLabel), ...p.mods.map(cardLabel)].join(' ');
    const st = { active: 'active', stayed: 'stay', frozen: 'FROZEN', busted: 'BUST' }[p.status];
    L.push(` ${mark} ${p.name.padEnd(12)} [${hand}]${p.scCard ? ' (SC)' : ''} ${st}`);
  });
  L.push(' TOTALS: ' + t.players.map(p => `${p.name} ${p.total}`).join(' | '));
  return L;
}
function showTable(t) { tableLines(t).forEach(x => line(t, x, 'table')); }

function resolveAction(t, p, c) {
  if (c.t === 'sc') {
    if (!p.scCard) { p.scCard = c; line(t, `${p.name} keeps their SECOND CHANCE`, 'good'); return; }
    const elig = actives(t).filter(x => x !== p && !x.scCard);
    if (!elig.length) { t.discard.push(c); line(t, 'nobody can take the SECOND CHANCE: discarded', 'sys'); return; }
    if (elig.length === 1) { elig[0].scCard = c; line(t, `${p.name} gives the SECOND CHANCE to ${elig[0].name}`, 'good'); return; }
    t.pending = { kind: 'sc', chooser: p, card: c, elig };
    return;
  }
  const elig = actives(t);
  if (!elig.length) { t.discard.push(c); return; }
  if (elig.length === 1) { applyTarget(t, p, c, elig[0]); return; }
  t.pending = { kind: c.t, chooser: p, card: c, elig };
}

function applyTarget(t, chooser, c, target) {
  t.discard.push(c);
  if (c.t === 'freeze') {
    target.status = 'frozen';
    line(t, `❄ ${chooser.name} freezes ${target.name}: they bank their cards and are out of the round`, 'warn');
  } else {
    line(t, `⟳ ${chooser.name} throws FLIP3 at ${target.name}: they draw 3 cards in a row`, 'warn');
    t.tasks.unshift({ player: target, source: 'flip3' }, { player: target, source: 'flip3' }, { player: target, source: 'flip3' });
  }
}

function resolveOne(t, task) {
  const p = task.player;
  if (task.source === 'held') { resolveAction(t, p, task.card); return; }
  const c = draw(t);
  if (!c) { line(t, 'no cards left: forced end of round', 'warn'); endRound(t); return; }
  const via = task.source === 'flip3' ? ' (flip3)' : task.source === 'deal' ? ' (deal)' : '';
  if (c.t === 'n') {
    if (p.cards.some(x => x.v === c.v)) {
      if (p.scCard) {
        t.discard.push(c, p.scCard);
        p.scCard = null;
        line(t, `${p.name} draws ${c.v}${via}: duplicate! uses their SECOND CHANCE and survives`, 'warn');
      } else {
        p.cards.push(c);
        p.status = 'busted';
        line(t, `${p.name} draws ${c.v}${via}: DUPLICATE! BUST, 0 points this round`, 'err');
      }
    } else {
      p.cards.push(c);
      line(t, `${p.name} draws ${c.v}${via}`);
      if (p.cards.length === 7) {
        p.flip7 = true;
        line(t, `★★★ FLIP 7 by ${p.name}! +15 and the round ends ★★★`, 'good');
        endRound(t);
      }
    }
  } else if (c.t === 'mod' || c.t === 'x2') {
    p.mods.push(c);
    line(t, `${p.name} draws ${cardLabel(c)}${via}`);
  } else {
    line(t, `${p.name} draws ${cardLabel(c)}${via}`, 'warn');
    if (task.source === 'flip3' && c.t !== 'sc') {
      let i = 0;
      while (i < t.tasks.length && t.tasks[i].source === 'flip3') i++;
      t.tasks.splice(i, 0, { player: p, source: 'held', card: c });
      lineTo(p, '(action card resolves after the FLIP3 ends)', 'sys');
    } else {
      resolveAction(t, p, c);
    }
  }
}

function promptPending(t) {
  const { kind, chooser, elig } = t.pending;
  const label = { freeze: 'FREEZE', flip3: 'FLIP3', sc: 'SECOND CHANCE' }[kind];
  lineTo(chooser, `— pick a target for ${label}: ${elig.map(e => e.name).join(' | ')}  (type the name)`, 'prompt');
  t.players.filter(x => x !== chooser).forEach(x => lineTo(x, `— ${chooser.name} is picking a target for ${label}... —`, 'sys'));
  if (chooser.isBot) setTimeout(() => botChoose(t), BOT_MS + Math.random() * BOT_MS);
}

function promptTurn(t) {
  showTable(t);
  const p = t.players[t.turn];
  t.players.forEach(x => lineTo(x, x === p ? `— your turn, ${p.name}: hit | stay` : `— ${p.name}'s turn —`, x === p ? 'prompt' : 'sys'));
  if (p.isBot) setTimeout(() => botTurn(t, p), BOT_MS + Math.random() * BOT_MS);
}

function resolveChoice(t, chooser, target) {
  const pd = t.pending;
  t.pending = null;
  if (pd.kind === 'sc') { target.scCard = pd.card; line(t, `${chooser.name} gives the SECOND CHANCE to ${target.name}`, 'good'); }
  else applyTarget(t, chooser, pd.card, target);
  proceed(t);
}

function botTurn(t, p) {
  if (t.phase !== 'playing' || t.players[t.turn] !== p || t.pending || p.status !== 'active') return;
  const sum = p.cards.reduce((a, c) => a + c.v, 0);
  let hit;
  if (p.cards.length === 6) hit = Math.random() < 0.5;
  else if (p.scCard && sum < 30) hit = true;
  else hit = sum + Math.random() * 8 < 18;
  if (hit) { t.tasks.push({ player: p, source: 'hit' }); proceed(t); }
  else { p.status = 'stayed'; line(t, `${p.name} stays`, 'sys'); proceed(t); }
}

function botChoose(t) {
  const pd = t.pending;
  if (!pd || !pd.chooser.isBot) return;
  const bot = pd.chooser;
  const others = pd.elig.filter(e => e !== bot);
  let target;
  if (pd.kind === 'freeze') target = others.length ? others.reduce((a, b) => computeScore(b) > computeScore(a) ? b : a) : pd.elig[0];
  else if (pd.kind === 'flip3' && bot.status === 'active' && bot.cards.length <= 2 && pd.elig.includes(bot)) target = bot;
  else target = others[Math.floor(Math.random() * others.length)] || pd.elig[0];
  resolveChoice(t, bot, target);
}

function nextTurnOrEnd(t) {
  const n = t.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (t.turn + k) % n;
    if (t.players[i].status === 'active') { t.turn = i; promptTurn(t); return; }
  }
  endRound(t);
}

function proceed(t) {
  if (t.pending) { promptPending(t); return; }
  while (t.tasks.length) {
    const task = t.tasks.shift();
    if (task.player.status !== 'active') { if (task.card) t.discard.push(task.card); continue; }
    resolveOne(t, task);
    if (t.phase !== 'dealing' && t.phase !== 'playing') return;
    if (t.pending) { promptPending(t); return; }
  }
  if (t.phase === 'dealing') {
    t.phase = 'playing';
    t.turn = (t.first - 1 + t.players.length) % t.players.length;
    nextTurnOrEnd(t);
  } else if (t.phase === 'playing') {
    nextTurnOrEnd(t);
  }
}

function endRound(t) {
  if (t.phase !== 'dealing' && t.phase !== 'playing') return;
  t.tasks = [];
  t.pending = null;
  t.phase = 'between';
  line(t, `── END OF ROUND ${t.round} ──`, 'table');
  for (const p of t.players) {
    const s = computeScore(p);
    p.total += s;
    const hand = p.status === 'busted' ? 'BUST' : [...p.cards.map(cardLabel), ...p.mods.map(cardLabel)].join(' ') || '(nothing)';
    line(t, ` ${p.name.padEnd(12)} ${hand}${p.flip7 ? ' FLIP7 +15!' : ''} → +${s}  (total ${p.total})`, 'table');
    t.discard.push(...p.cards, ...p.mods);
    if (p.scCard) { t.discard.push(p.scCard); p.scCard = null; }
    p.cards = []; p.mods = []; p.flip7 = false;
  }
  const max = Math.max(...t.players.map(p => p.total));
  if (max >= 200) {
    const top = t.players.filter(p => p.total === max);
    if (top.length === 1) { gameOver(t, top[0]); return; }
    line(t, 'tie at the top: tiebreaker round', 'warn');
  }
  t.timer = setTimeout(() => startRound(t), 1500);
}

function gameOver(t, w) {
  t.phase = 'over';
  line(t, `★ ${w.name} WINS with ${w.total} points ★`, 'good');
  line(t, 'type start to play again', 'sys');
}

function startRound(t) {
  if (t.phase !== 'between') return;
  t.round++;
  const n = t.players.length;
  t.first = (t.first + 1) % n;
  t.players.forEach(p => { p.status = 'active'; });
  t.phase = 'dealing';
  line(t, `════ ROUND ${t.round} ════`, 'good');
  for (let k = 0; k < n; k++) t.tasks.push({ player: t.players[(t.first + k) % n], source: 'deal' });
  proceed(t);
}

function startGame(t) {
  clearTimeout(t.timer);
  t.deck = shuffle(buildDeck());
  t.discard = [];
  t.round = 0;
  t.first = -1;
  t.tasks = [];
  t.pending = null;
  t.players.forEach(p => { p.total = 0; p.cards = []; p.mods = []; p.scCard = null; p.flip7 = false; p.status = 'active'; });
  t.phase = 'between';
  startRound(t);
}

function fliptable(t, p) {
  clearTimeout(t.timer);
  t.players.forEach(x => sendTo(x.id, { type: 'fliptable', by: p.name }));
  t.phase = 'lobby';
  t.tasks = [];
  t.pending = null;
  t.round = 0;
  t.players.forEach(x => { x.total = 0; x.cards = []; x.mods = []; x.scCard = null; x.flip7 = false; x.status = 'active'; });
  t.timer = setTimeout(() => {
    line(t, `※ ${p.name} FLIPPED THE TABLE ※  (╯°□°)╯︵ ┻━┻`, 'err');
    line(t, 'cards everywhere... game voided. type start to play again', 'sys');
  }, 2300);
}

function endTable(t, p) {
  clearTimeout(t.timer);
  line(t, `${p.name} ended table ${t.name}: everyone up, seats cleared`, 'err');
  line(t, 'back to the hall: tables, create <table> or enter <table>', 'sys');
  t.phase = 'lobby';
  t.tasks = [];
  t.pending = null;
  tables.delete(t.name.toLowerCase());
}

const HELP = [
  'commands:',
  '  join <name>     pick your player name',
  '  tables          list tables',
  '  create <table>  create a table and sit at it',
  '  enter <table>   sit at an existing table (before it starts)',
  '  leave           leave your table (before it starts)',
  '  start           start the game (bots fill the table up to 3 players)',
  '  hit             draw a card on your turn',
  '  stay            stand and bank your points',
  '  <name>          pick a target when asked (FREEZE/FLIP3/SC)',
  '  table           show your table',
  '  end             end your table and clear all seats',
  '  fliptable       (╯°□°)╯︵ ┻━┻',
  '  help            this help',
  'rules: 7 unique numbers = +15 and ends the round · duplicate number = BUST · first to 200 wins',
];

function handle(id, raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);
  const c = cmd.toLowerCase();
  const seat = findSeat(id);
  const nick = nicks.get(id);

  if (c === 'help') { HELP.forEach(l => lineId(id, l, 'sys')); return; }

  if (c === 'join') {
    if (seat) { lineId(id, `you're already at table ${seat.t.name} as ${seat.p.name}`, 'err'); return; }
    const name = rest[0];
    if (!name || !/^[\w-]{1,12}$/.test(name)) { lineId(id, 'usage: join <name> (letters/numbers, max 12)', 'err'); return; }
    nicks.set(id, name);
    lineId(id, `hi ${name} · tables lists tables, create <table> makes one, enter <table> joins one`, 'good');
    return;
  }

  if (c === 'tables') {
    if (!tables.size) { lineId(id, 'no tables yet: create <table>', 'sys'); return; }
    lineId(id, '── tables ──', 'table');
    for (const t of tables.values()) {
      const st = t.phase === 'lobby' || t.phase === 'over' ? 'waiting' : `playing (round ${t.round})`;
      lineId(id, ` · ${t.name.padEnd(12)} ${t.players.length} player${t.players.length === 1 ? '' : 's'}  ${st}`, 'table');
    }
    return;
  }

  if (c === 'create' || c === 'enter') {
    if (seat) { lineId(id, `you're already at table ${seat.t.name}`, 'err'); return; }
    if (!nick) { lineId(id, 'pick your name first: join <name>', 'err'); return; }
    const tname = rest[0];
    if (!tname || !/^[\w-]{1,12}$/.test(tname)) { lineId(id, `usage: ${c} <table> (letters/numbers, max 12)`, 'err'); return; }
    const key = tname.toLowerCase();
    let t = tables.get(key);
    if (c === 'create') {
      if (t) { lineId(id, `table ${t.name} already exists: enter ${t.name}`, 'err'); return; }
      t = newTable(tname);
      tables.set(key, t);
    } else {
      if (!t) { lineId(id, `no table named ${tname}: tables lists them`, 'err'); return; }
      if (t.phase !== 'lobby' && t.phase !== 'over') { lineId(id, `table ${t.name} already started`, 'err'); return; }
      if (t.players.some(x => x.name.toLowerCase() === nick.toLowerCase())) { lineId(id, `name ${nick} is taken at that table`, 'err'); return; }
    }
    const p = { id, name: nick, total: 0, cards: [], mods: [], scCard: null, flip7: false, status: 'active' };
    t.players.push(p);
    line(t, `+ ${nick} sits at table ${t.name} (${t.players.length} player${t.players.length > 1 ? 's' : ''})`, 'good');
    lineTo(p, 'type start when ready (bots fill the table up to 3 players)', 'prompt');
    return;
  }

  if (!seat) { lineId(id, nick ? 'you are not at a table: tables, create <table> or enter <table>' : 'pick your name first: join <name>', 'err'); return; }
  const { t, p } = seat;

  if (c === 'leave') {
    if (t.phase !== 'lobby' && t.phase !== 'over') { lineTo(p, "you can't leave mid-game (end ends the table)", 'err'); return; }
    t.players = t.players.filter(x => x !== p);
    lineTo(p, `you left table ${t.name}`, 'sys');
    line(t, `${p.name} left the table (${t.players.length} left)`, 'sys');
    if (!t.players.some(x => !x.isBot)) tables.delete(t.name.toLowerCase());
    return;
  }

  if (c === 'table') { tableLines(t).forEach(x => lineTo(p, x, 'table')); return; }

  if (c === 'end') { endTable(t, p); return; }

  if (c === 'fliptable') { fliptable(t, p); return; }

  if (c === 'debug') {
    const inHands = t.players.reduce((a, x) => a + x.cards.length + x.mods.length + (x.scCard ? 1 : 0), 0);
    lineTo(p, `debug: deck ${t.deck.length} discard ${t.discard.length} hands ${inHands} total ${t.deck.length + t.discard.length + inHands}`, 'sys');
    return;
  }

  if (c === 'start') {
    if (t.phase !== 'lobby' && t.phase !== 'over') { lineTo(p, 'game already in progress', 'err'); return; }
    t.players = t.players.filter(x => !x.isBot);
    const free = BOT_NAMES.filter(n => !t.players.some(x => x.name.toLowerCase() === n));
    while (t.players.length < 3) {
      const b = { id: 'bot-' + free.length, name: free.pop(), total: 0, cards: [], mods: [], scCard: null, flip7: false, status: 'active', isBot: true };
      t.players.push(b);
      line(t, `+ ${b.name} sits at table ${t.name} (bot)`, 'good');
    }
    line(t, `${p.name} starts the game to 200 points`, 'good');
    startGame(t);
    return;
  }

  if (t.pending && t.pending.chooser === p) {
    const nm = (c === 'freeze' || c === 'flip3' || c === 'give') ? rest[0] : cmd;
    const target = t.pending.elig.find(e => e.name.toLowerCase() === (nm || '').toLowerCase());
    if (!target) { lineTo(p, `invalid target. options: ${t.pending.elig.map(e => e.name).join(' | ')}`, 'err'); return; }
    resolveChoice(t, p, target);
    return;
  }

  if (c === 'hit' || c === 'stay') {
    if (t.phase !== 'playing') { lineTo(p, "you can't do that now", 'err'); return; }
    if (t.pending) { lineTo(p, 'a choice is pending', 'err'); return; }
    if (t.players[t.turn] !== p) { lineTo(p, 'not your turn', 'err'); return; }
    if (p.status !== 'active') { lineTo(p, "you're out of this round", 'err'); return; }
    if (c === 'hit') { t.tasks.push({ player: p, source: 'hit' }); proceed(t); }
    else { p.status = 'stayed'; line(t, `${p.name} stays`, 'sys'); proceed(t); }
    return;
  }

  lineTo(p, `unknown command: ${cmd}. type help`, 'err');
}

const WELCOME = [
  '   __ _ _        _____ ',
  '  / _| (_)_ __  |___  |',
  ' | |_| | | \'_ \\    / / ',
  ' |  _| | | |_) |  / /  ',
  ' |_| |_|_| .__/  /_/   ',
  '         |_|           ',
  'welcome to flipterm · type: join <name>',
  'then create <table> or enter <table> · help to see commands',
];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  if (u.pathname === '/events') {
    const id = u.searchParams.get('id');
    if (!id || !/^[a-z0-9]{6,20}$/.test(id)) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    conns.set(id, res);
    req.on('close', () => { if (conns.get(id) === res) conns.delete(id); });
    const seat = findSeat(id);
    const lines = seat ? [`reconnected as ${seat.p.name} at table ${seat.t.name}`] : WELCOME;
    lines.forEach(x => res.write(`data: ${JSON.stringify({ type: 'line', text: x, cls: 'sys' })}\n\n`));
    return;
  }
  if (u.pathname === '/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { const { id, cmd } = JSON.parse(body); handle(id, cmd); } catch {}
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

setInterval(() => {
  for (const res of conns.values()) { try { res.write(': ka\n\n'); } catch {} }
}, 25000);

server.listen(PORT, () => console.log(`flipterm · http://localhost:${PORT}`));
