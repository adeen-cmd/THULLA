# Bhabhi (Thulla) — online

Multiplayer Bhabhi for 3–6 players. Open a table, send friends the link, play in the browser. Bots fill empty seats.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000. To test with yourself, open a second browser window in private/incognito mode — seats are tied to a token in `localStorage`, so two normal tabs will try to claim the same seat.

## Put it online

The whole app is one Node process with no database, so anywhere that runs Node works. It needs a **persistent** server — Vercel and Netlify serverless functions won't work, because rooms live in memory and websockets need a long-lived connection.

**Render** (free tier, simplest): push this folder to GitHub, create a new Web Service, build command `npm install`, start command `npm start`. Done.

**Railway / Fly.io**: `railway up` or `fly launch` from this folder. Both detect Node automatically.

**Your own VPS**: `npm install --production`, then run under `pm2` or a systemd unit behind nginx. If you use nginx, pass websocket headers through:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

The server reads `PORT` from the environment, which is what every host sets.

## Rules as implemented

- The whole deck is dealt out. Uneven hands are fine.
- Whoever holds the Ace of Spades must lead it.
- Follow the led suit if you hold it.
- If everyone follows, the highest card of the led suit wins. **Those cards leave the game permanently** and the winner leads next.
- If a player cannot follow, they cut with any card and **the trick stops immediately** — players after them never play. Whoever played the highest card of the led suit picks up the entire pile and leads next.
- Empty your hand and you're safe. The last player still holding cards is the Bhabhi.

Bhabhi varies a lot by region. The two rules groups most often disagree on are whether a cut ends the trick immediately or play continues around, and whether the Ace of Spades lead is mandatory. Both live in `game.js` — `playCard` for the first, `legalCards` for the second.

## How it's put together

```
game.js    rules engine — pure functions, no I/O
server.js  rooms, sockets, timers, bots
public/    the client
test.js    engine test suite (npm test)
```

The server is authoritative. `game.js` is the only place that knows the deck, and it lives on the server only. Clients receive the output of `redact()`: their own hand plus a **card count** for everyone else. A player cannot read opponents' cards out of memory, because their browser never receives them.

Every incoming move is re-validated server-side with `legalCards` before it is applied, so a tampered client gets an error rather than an illegal play. The legality check in the browser only greys out cards — it is a convenience, never the enforcement.

### Timing (override with environment variables)

| Variable | Default | What it controls |
| --- | --- | --- |
| `TURN_MS` | 45000 | How long a player has before the server plays a reasonable card for them |
| `RESOLVE_MS` | 1900 | How long a finished trick stays on screen |
| `BOT_MS` | 900 | Bot thinking time |
| `DROP_MS` | 6000 | Grace period before auto-playing for someone who dropped |

### Dropping and reconnecting

Each browser stores a random token. Rejoining with that token reclaims the same seat and hand, so a refresh or a lost connection doesn't cost the round. While someone is away the server auto-plays sensible cards for them rather than freezing the table. If the host leaves in the lobby, the next player becomes host. A table is discarded 30 minutes after the last human leaves.

## Testing

`npm test` runs 4,800 full rounds across every table size, checking follow-suit enforcement, the forced opening lead, pile ownership after a cut, finishing order, and that the redacted view never contains another player's cards.

## Ideas worth adding next

- Persist `tally` so a group's Bhabhi count survives a restart (Redis or SQLite — a few lines).
- A rules toggle in the lobby for the cut-ends-trick and mandatory-ace variants.
- Sound, and a nudge button for slow players.
- Spectators: `redact(g, null)` already returns a valid hand-free view.
