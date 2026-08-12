# flipterm

A light multiplayer version of the Flip 7 card game, played through a terminal-style interface in the browser. Every action is a typed command, the board is rendered as text, and there is a `fliptable` command that sends the whole table flying.

## Requirements

- Node.js 18+ (no dependencies, nothing to install)

## Run

```bash
node server.js
```

Then open `http://localhost:7177` in your browser.

- **Multiplayer**: open one tab per player (or two different browsers). Each tab is its own player.
- **Solo**: join alone and type `start`; bots fill the table up to 3 players and play on their own.

To play from another device on the same network, open `http://<your-local-ip>:7177`.

## Play online

The server holds all game state, so remote play just needs the server reachable on the internet. Everyone opens the same URL; each group creates its own table (`create <table>`) and others join it with `enter <table>` before it starts.

- **Render (free)**: create a Web Service from this repo, no build command, start command `node server.js`. The free tier sleeps after idle and the game state lives in memory, so an in-progress game is lost when it spins down.
- **Quick session without deploying**: run it locally and expose it with `cloudflared tunnel --url http://localhost:7177` (or ngrok), then share the URL.

The server reads the port from the `PORT` env var (defaults to 7177).

## How to play

Type commands at the `flipterm>` prompt:

| Command | Action |
|---|---|
| `join <name>` | pick your player name |
| `tables` | list tables |
| `create <table>` | create a table and sit at it |
| `enter <table>` | sit at an existing table (before it starts) |
| `leave` | leave your table (before it starts) |
| `start` | start the game (bots fill the table up to 3 players) |
| `hit` | draw a card on your turn |
| `stay` | stand and bank your points |
| `<name>` | pick a target when the game asks (FREEZE / FLIP3 / SECOND CHANCE) |
| `table` | reprint your table |
| `end` | end your table and clear all seats |
| `fliptable` | (╯°□°)╯︵ ┻━┻ everything flies and the game is voided |
| `help` | show the command list |

Arrow keys navigate command history. If you close the tab, reopening it reconnects you to your seat.

## Rules

Official 94-card deck:

- **Numbers 0-12**: each number N appears N times in the deck (the 0 appears once).
- **Modifiers**: +2, +4, +6, +8, +10 and x2 (one of each).
- **Actions**: FREEZE, FLIP3 and SECOND CHANCE (3 of each).

Each round every player is dealt one card, then takes turns choosing `hit` or `stay`:

- Drawing a **duplicate number** busts you: 0 points for the round, unless you hold a SECOND CHANCE (both cards are discarded and you survive).
- **7 unique numbers** is a FLIP 7: +15 bonus and the round ends immediately for everyone.
- **FREEZE**: the target banks their cards and is out of the round.
- **FLIP3**: the target draws 3 cards in a row. Action cards drawn during it resolve after the three flips (SECOND CHANCE resolves immediately).
- **SECOND CHANCE**: keep it; if you already have one, it goes to another active player, or gets discarded if nobody can take it.

Round score: sum of your number cards, doubled by x2 if you have it, plus the +N modifiers. Busted players score 0. First player to reach 200 points at the end of a round wins (ties trigger a tiebreaker round).

## Bots

Any seat below 3 players is filled with a bot on `start`. Bots decide on their own: they press their luck based on their round score, throw FREEZE at the leading opponent, and keep FLIP3 for themselves when their hand is small. Adjust their speed with:

```bash
BOT_MS=200 node server.js   # default 700 (ms between bot actions)
```

## Project layout

- `server.js`: game engine and HTTP server (SSE + POST, plain Node, no dependencies)
- `public/index.html`: terminal UI (single file, inline CSS/JS)
