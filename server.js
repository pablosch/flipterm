const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 7177;
const BOT_MS = +process.env.BOT_MS || 700;
const BOT_NAMES = ['hal9000', 'glados', 'skynet', 'wopr', 'deepblue'];
const conns = new Map();

const game = {
  phase: 'lobby', // lobby | between | dealing | playing | over
  players: [],
  deck: [], discard: [],
  round: 0, first: -1, turn: 0,
  tasks: [], pending: null, timer: null,
};

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

function send(p, msg) {
  const res = conns.get(p.id);
  if (res) { try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} }
}
function all(msg) { game.players.forEach(p => send(p, msg)); }
function line(text, cls) { all({ type: 'line', text, cls }); }
function lineTo(p, text, cls) { send(p, { type: 'line', text, cls }); }

const actives = () => game.players.filter(p => p.status === 'active');

function draw() {
  if (!game.deck.length) {
    if (!game.discard.length) return null;
    game.deck = shuffle(game.discard);
    game.discard = [];
    line('· deck ran out: reshuffling the discard pile ·', 'sys');
  }
  return game.deck.pop();
}

function computeScore(p) {
  if (p.status === 'busted') return 0;
  let s = p.cards.reduce((a, c) => a + c.v, 0);
  if (p.mods.some(m => m.t === 'x2')) s *= 2;
  s += p.mods.filter(m => m.t === 'mod').reduce((a, m) => a + m.v, 0);
  if (p.flip7) s += 15;
  return s;
}

function tableLines() {
  const L = [];
  L.push(`── TABLE · round ${game.round} · deck ${game.deck.length} ──`);
  game.players.forEach((p, i) => {
    const mark = game.phase === 'playing' && i === game.turn && p.status === 'active' ? '▶' : ' ';
    const hand = [...p.cards.map(cardLabel), ...p.mods.map(cardLabel)].join(' ');
    const st = { active: 'active', stayed: 'stay', frozen: 'FROZEN', busted: 'BUST' }[p.status];
    L.push(` ${mark} ${p.name.padEnd(12)} [${hand}]${p.scCard ? ' (SC)' : ''} ${st}`);
  });
  L.push(' TOTALS: ' + game.players.map(p => `${p.name} ${p.total}`).join(' | '));
  return L;
}
function showTable() { tableLines().forEach(t => line(t, 'table')); }

function resolveAction(p, c) {
  if (c.t === 'sc') {
    if (!p.scCard) { p.scCard = c; line(`${p.name} keeps their SECOND CHANCE`, 'good'); return; }
    const elig = actives().filter(x => x !== p && !x.scCard);
    if (!elig.length) { game.discard.push(c); line('nobody can take the SECOND CHANCE: discarded', 'sys'); return; }
    if (elig.length === 1) { elig[0].scCard = c; line(`${p.name} gives the SECOND CHANCE to ${elig[0].name}`, 'good'); return; }
    game.pending = { kind: 'sc', chooser: p, card: c, elig };
    return;
  }
  const elig = actives();
  if (!elig.length) { game.discard.push(c); return; }
  if (elig.length === 1) { applyTarget(p, c, elig[0]); return; }
  game.pending = { kind: c.t, chooser: p, card: c, elig };
}

function applyTarget(chooser, c, target) {
  game.discard.push(c);
  if (c.t === 'freeze') {
    target.status = 'frozen';
    line(`❄ ${chooser.name} freezes ${target.name}: they bank their cards and are out of the round`, 'warn');
  } else {
    line(`⟳ ${chooser.name} throws FLIP3 at ${target.name}: they draw 3 cards in a row`, 'warn');
    game.tasks.unshift({ player: target, source: 'flip3' }, { player: target, source: 'flip3' }, { player: target, source: 'flip3' });
  }
}

function resolveOne(t) {
  const p = t.player;
  if (t.source === 'held') { resolveAction(p, t.card); return; }
  const c = draw();
  if (!c) { line('no cards left: forced end of round', 'warn'); endRound(); return; }
  const via = t.source === 'flip3' ? ' (flip3)' : t.source === 'deal' ? ' (deal)' : '';
  if (c.t === 'n') {
    if (p.cards.some(x => x.v === c.v)) {
      if (p.scCard) {
        game.discard.push(c, p.scCard);
        p.scCard = null;
        line(`${p.name} draws ${c.v}${via}: duplicate! uses their SECOND CHANCE and survives`, 'warn');
      } else {
        p.cards.push(c);
        p.status = 'busted';
        line(`${p.name} draws ${c.v}${via}: DUPLICATE! BUST, 0 points this round`, 'err');
      }
    } else {
      p.cards.push(c);
      line(`${p.name} draws ${c.v}${via}`);
      if (p.cards.length === 7) {
        p.flip7 = true;
        line(`★★★ FLIP 7 by ${p.name}! +15 and the round ends ★★★`, 'good');
        endRound();
      }
    }
  } else if (c.t === 'mod' || c.t === 'x2') {
    p.mods.push(c);
    line(`${p.name} draws ${cardLabel(c)}${via}`);
  } else {
    line(`${p.name} draws ${cardLabel(c)}${via}`, 'warn');
    if (t.source === 'flip3' && c.t !== 'sc') {
      let i = 0;
      while (i < game.tasks.length && game.tasks[i].source === 'flip3') i++;
      game.tasks.splice(i, 0, { player: p, source: 'held', card: c });
      lineTo(p, '(action card resolves after the FLIP3 ends)', 'sys');
    } else {
      resolveAction(p, c);
    }
  }
}

function promptPending() {
  const { kind, chooser, elig } = game.pending;
  const label = { freeze: 'FREEZE', flip3: 'FLIP3', sc: 'SECOND CHANCE' }[kind];
  lineTo(chooser, `— pick a target for ${label}: ${elig.map(e => e.name).join(' | ')}  (type the name)`, 'prompt');
  game.players.filter(x => x !== chooser).forEach(x => lineTo(x, `— ${chooser.name} is picking a target for ${label}... —`, 'sys'));
  if (chooser.isBot) setTimeout(botChoose, BOT_MS + Math.random() * BOT_MS);
}

function promptTurn() {
  showTable();
  const p = game.players[game.turn];
  game.players.forEach(x => lineTo(x, x === p ? `— your turn, ${p.name}: hit | stay` : `— ${p.name}'s turn —`, x === p ? 'prompt' : 'sys'));
  if (p.isBot) setTimeout(() => botTurn(p), BOT_MS + Math.random() * BOT_MS);
}

function resolveChoice(chooser, target) {
  const pd = game.pending;
  game.pending = null;
  if (pd.kind === 'sc') { target.scCard = pd.card; line(`${chooser.name} gives the SECOND CHANCE to ${target.name}`, 'good'); }
  else applyTarget(chooser, pd.card, target);
  proceed();
}

function botTurn(p) {
  if (game.phase !== 'playing' || game.players[game.turn] !== p || game.pending || p.status !== 'active') return;
  const sum = p.cards.reduce((a, c) => a + c.v, 0);
  let hit;
  if (p.cards.length === 6) hit = Math.random() < 0.5;
  else if (p.scCard && sum < 30) hit = true;
  else hit = sum + Math.random() * 8 < 18;
  if (hit) { game.tasks.push({ player: p, source: 'hit' }); proceed(); }
  else { p.status = 'stayed'; line(`${p.name} stays`, 'sys'); proceed(); }
}

function botChoose() {
  const pd = game.pending;
  if (!pd || !pd.chooser.isBot) return;
  const bot = pd.chooser;
  const others = pd.elig.filter(e => e !== bot);
  let target;
  if (pd.kind === 'freeze') target = others.length ? others.reduce((a, b) => computeScore(b) > computeScore(a) ? b : a) : pd.elig[0];
  else if (pd.kind === 'flip3' && bot.status === 'active' && bot.cards.length <= 2 && pd.elig.includes(bot)) target = bot;
  else target = others[Math.floor(Math.random() * others.length)] || pd.elig[0];
  resolveChoice(bot, target);
}

function nextTurnOrEnd() {
  const n = game.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (game.turn + k) % n;
    if (game.players[i].status === 'active') { game.turn = i; promptTurn(); return; }
  }
  endRound();
}

function proceed() {
  if (game.pending) { promptPending(); return; }
  while (game.tasks.length) {
    const t = game.tasks.shift();
    if (t.player.status !== 'active') { if (t.card) game.discard.push(t.card); continue; }
    resolveOne(t);
    if (game.phase !== 'dealing' && game.phase !== 'playing') return;
    if (game.pending) { promptPending(); return; }
  }
  if (game.phase === 'dealing') {
    game.phase = 'playing';
    game.turn = (game.first - 1 + game.players.length) % game.players.length;
    nextTurnOrEnd();
  } else if (game.phase === 'playing') {
    nextTurnOrEnd();
  }
}

function endRound() {
  if (game.phase !== 'dealing' && game.phase !== 'playing') return;
  game.tasks = [];
  game.pending = null;
  game.phase = 'between';
  line(`── END OF ROUND ${game.round} ──`, 'table');
  for (const p of game.players) {
    const s = computeScore(p);
    p.total += s;
    const hand = p.status === 'busted' ? 'BUST' : [...p.cards.map(cardLabel), ...p.mods.map(cardLabel)].join(' ') || '(nothing)';
    line(` ${p.name.padEnd(12)} ${hand}${p.flip7 ? ' FLIP7 +15!' : ''} → +${s}  (total ${p.total})`, 'table');
    game.discard.push(...p.cards, ...p.mods);
    if (p.scCard) { game.discard.push(p.scCard); p.scCard = null; }
    p.cards = []; p.mods = []; p.flip7 = false;
  }
  const max = Math.max(...game.players.map(p => p.total));
  if (max >= 200) {
    const top = game.players.filter(p => p.total === max);
    if (top.length === 1) { gameOver(top[0]); return; }
    line('tie at the top: tiebreaker round', 'warn');
  }
  game.timer = setTimeout(startRound, 1500);
}

function gameOver(w) {
  game.phase = 'over';
  line(`★ ${w.name} WINS with ${w.total} points ★`, 'good');
  line('type start to play again', 'sys');
}

function startRound() {
  if (game.phase !== 'between') return;
  game.round++;
  const n = game.players.length;
  game.first = (game.first + 1) % n;
  game.players.forEach(p => { p.status = 'active'; });
  game.phase = 'dealing';
  line(`════ ROUND ${game.round} ════`, 'good');
  for (let k = 0; k < n; k++) game.tasks.push({ player: game.players[(game.first + k) % n], source: 'deal' });
  proceed();
}

function startGame() {
  clearTimeout(game.timer);
  game.deck = shuffle(buildDeck());
  game.discard = [];
  game.round = 0;
  game.first = -1;
  game.tasks = [];
  game.pending = null;
  game.players.forEach(p => { p.total = 0; p.cards = []; p.mods = []; p.scCard = null; p.flip7 = false; p.status = 'active'; });
  game.phase = 'between';
  startRound();
}

function fliptable(p) {
  clearTimeout(game.timer);
  all({ type: 'fliptable', by: p.name });
  game.phase = 'lobby';
  game.tasks = [];
  game.pending = null;
  game.round = 0;
  game.players.forEach(x => { x.total = 0; x.cards = []; x.mods = []; x.scCard = null; x.flip7 = false; x.status = 'active'; });
  game.timer = setTimeout(() => {
    line(`※ ${p.name} FLIPPED THE TABLE ※  (╯°□°)╯︵ ┻━┻`, 'err');
    line('cards everywhere... game voided. type start to play again', 'sys');
  }, 2300);
}

const HELP = [
  'commands:',
  '  join <name>     sit at the table',
  '  start           start the game (bots fill the table up to 3 players)',
  '  hit             draw a card on your turn',
  '  stay            stand and bank your points',
  '  <name>          pick a target when asked (FREEZE/FLIP3/SC)',
  '  table           show the table',
  '  fliptable       (╯°□°)╯︵ ┻━┻',
  '  help            this help',
  'rules: 7 unique numbers = +15 and ends the round · duplicate number = BUST · first to 200 wins',
];

function handle(id, raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);
  const c = cmd.toLowerCase();
  let p = game.players.find(x => x.id === id);
  const me = p || { id };

  if (c === 'help') { HELP.forEach(l => lineTo(me, l, 'sys')); return; }

  if (c === 'join') {
    if (p) { lineTo(p, `you're already at the table as ${p.name}`, 'err'); return; }
    const name = rest[0];
    if (!name || !/^[\w-]{1,12}$/.test(name)) { lineTo(me, 'usage: join <name> (letters/numbers, max 12)', 'err'); return; }
    if (game.players.some(x => x.name.toLowerCase() === name.toLowerCase())) { lineTo(me, 'that name is taken', 'err'); return; }
    const inGame = game.phase !== 'lobby' && game.phase !== 'over';
    p = { id, name, total: 0, cards: [], mods: [], scCard: null, flip7: false, status: inGame ? 'stayed' : 'active' };
    game.players.push(p);
    line(`+ ${name} sits at the table (${game.players.length} player${game.players.length > 1 ? 's' : ''})`, 'good');
    if (!inGame && game.players.length >= 2) line('type start to begin', 'prompt');
    else if (inGame) lineTo(p, 'you join starting next round', 'sys');
    return;
  }

  if (!p) { lineTo(me, 'join first: join <name>', 'err'); return; }

  if (c === 'table') { tableLines().forEach(t => lineTo(p, t, 'table')); return; }

  if (c === 'fliptable') { fliptable(p); return; }

  if (c === 'debug') {
    const inHands = game.players.reduce((a, x) => a + x.cards.length + x.mods.length + (x.scCard ? 1 : 0), 0);
    lineTo(p, `debug: deck ${game.deck.length} discard ${game.discard.length} hands ${inHands} total ${game.deck.length + game.discard.length + inHands}`, 'sys');
    return;
  }

  if (c === 'start') {
    if (game.phase !== 'lobby' && game.phase !== 'over') { lineTo(p, 'game already in progress', 'err'); return; }
    game.players = game.players.filter(x => !x.isBot);
    const free = BOT_NAMES.filter(n => !game.players.some(x => x.name.toLowerCase() === n));
    while (game.players.length < 3) {
      const b = { id: 'bot-' + free.length, name: free.pop(), total: 0, cards: [], mods: [], scCard: null, flip7: false, status: 'active', isBot: true };
      game.players.push(b);
      line(`+ ${b.name} sits at the table (bot)`, 'good');
    }
    line(`${p.name} starts the game to 200 points`, 'good');
    startGame();
    return;
  }

  if (game.pending && game.pending.chooser === p) {
    const nm = (c === 'freeze' || c === 'flip3' || c === 'give') ? rest[0] : cmd;
    const target = game.pending.elig.find(e => e.name.toLowerCase() === (nm || '').toLowerCase());
    if (!target) { lineTo(p, `invalid target. options: ${game.pending.elig.map(e => e.name).join(' | ')}`, 'err'); return; }
    resolveChoice(p, target);
    return;
  }

  if (c === 'hit' || c === 'stay') {
    if (game.phase !== 'playing') { lineTo(p, "you can't do that now", 'err'); return; }
    if (game.pending) { lineTo(p, 'a choice is pending', 'err'); return; }
    if (game.players[game.turn] !== p) { lineTo(p, 'not your turn', 'err'); return; }
    if (p.status !== 'active') { lineTo(p, "you're out of this round", 'err'); return; }
    if (c === 'hit') { game.tasks.push({ player: p, source: 'hit' }); proceed(); }
    else { p.status = 'stayed'; line(`${p.name} stays`, 'sys'); proceed(); }
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
  'help to see commands',
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
    const p = game.players.find(x => x.id === id);
    const lines = p ? [`reconnected as ${p.name}`] : WELCOME;
    lines.forEach(t => res.write(`data: ${JSON.stringify({ type: 'line', text: t, cls: 'sys' })}\n\n`));
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

server.listen(PORT, () => console.log(`flipterm · http://localhost:${PORT}`));
