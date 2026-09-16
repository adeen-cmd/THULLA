"use strict";
/**
 * Bhabhi server. Authoritative: it owns every deck, validates every move,
 * and sends each socket only the cards that socket is entitled to see.
 */

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const G = require("./game");

const PORT = process.env.PORT || 3000;
const TURN_MS = +process.env.TURN_MS || 60000;      // auto-play if a player stalls this long
const RESOLVE_MS = +process.env.RESOLVE_MS || 3200; // hold a finished trick on screen before clearing
const BOT_MS = +process.env.BOT_MS || 1800;          // bot thinking time
const DROP_MS = +process.env.DROP_MS || 6000;       // grace before auto-playing a dropped player
const EMPTY_ROOM_MS = 1000 * 60 * 30;

const MIN_SEATS = 3;
const MAX_SEATS = 6;
const BOT_NAMES = ["Ali", "Sara", "Zoya", "Bilal", "Hina", "Imran"];

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Room>} */
const rooms = new Map();

const newCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(""); }
  while (rooms.has(c));
  return c;
};

const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);

function makeRoom(code) {
  return {
    code,
    players: [],      // {token, name, bot, socketId, connected, place}
    game: null,
    phase: "lobby",   // lobby | playing | over
    hostToken: null,
    feed: [],         // {k:'sys'|'chat', name?, msg}
    tally: {},        // name -> times been Bhabhi
    timer: null,
    resolving: false,
    deadline: 0,
    lastEvent: null,
    touched: Date.now(),
  };
}

const bySocket = (room, id) => room.players.findIndex((p) => p.socketId === id);
const byToken = (room, t) => room.players.findIndex((p) => p.token === t);

function sys(room, msg) { push(room, { k: "sys", msg }); }
function push(room, entry) {
  room.feed.push(entry);
  if (room.feed.length > 60) room.feed.shift();
}

/* ------------------------------------------------------------------ */
/* Broadcasting                                                        */
/* ------------------------------------------------------------------ */

function view(room, seat) {
  const base = {
    code: room.code,
    phase: room.phase,
    you: seat,
    isHost: seat !== null && room.players[seat] && room.players[seat].token === room.hostToken,
    players: room.players.map((p, i) => ({
      seat: i, name: p.name, bot: !!p.bot, connected: !!p.connected || !!p.bot,
    })),
    feed: room.feed.slice(-40),
    tally: room.tally,
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    deadline: room.deadline || 0,
    lastEvent: room.lastEvent,
  };
  if (room.game) Object.assign(base, G.redact(room.game, seat, { resolving: room.resolving }));
  return base;
}

function emitAll(room) {
  room.touched = Date.now();
  for (const p of room.players) {
    if (p.bot || !p.socketId) continue;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit("state", view(room, room.players.indexOf(p)));
  }
}

/* ------------------------------------------------------------------ */
/* Turn driving                                                        */
/* ------------------------------------------------------------------ */

function advance(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = 0;
  const g = room.game;
  if (!g || g.over || room.resolving) return;

  const seat = G.whoseTurn(g);
  if (seat === null) return;
  const p = room.players[seat];

  if (p.bot) {
    room.timer = setTimeout(() => autoPlay(room, seat), BOT_MS);
  } else if (!p.connected) {
    // Don't stall the table on someone whose phone dropped.
    room.timer = setTimeout(() => autoPlay(room, seat), DROP_MS);
  } else {
    room.deadline = Date.now() + TURN_MS;
    room.timer = setTimeout(() => autoPlay(room, seat), TURN_MS);
  }
}

function autoPlay(room, seat) {
  const g = room.game;
  if (!g || g.over || room.resolving || G.whoseTurn(g) !== seat) return;
  const card = G.botPick(g, seat);
  if (card) doPlay(room, seat, card, !room.players[seat].bot);
}

function doPlay(room, seat, card, auto) {
  const g = room.game;
  let ev;
  try {
    ev = G.playCard(g, seat, card);
  } catch (e) {
    return { error: e.message };
  }

  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = 0;

  const who = room.players[seat].name;
  sys(room, `${who} played ${G.cardName(ev.card)}${auto ? " (auto)" : ""}`);

  if (ev.type === "played") {
    room.lastEvent = null;
    emitAll(room);
    advance(room);
    return {};
  }

  if (ev.type === "cut") {
    room.lastEvent = { type: "cut", eater: ev.eater, n: ev.cards.length };
    sys(room, `Thulla — ${room.players[ev.eater].name} picks up ${ev.cards.length}`);
  } else {
    room.lastEvent = { type: "clean", winner: ev.winner, n: ev.cards.length };
    sys(room, `${room.players[ev.winner].name} takes it, ${ev.cards.length} cards out of play`);
  }
  for (const s of ev.outs) {
    sys(room, `${room.players[s].name} is out (${ordinal(g.finished.indexOf(s) + 1)})`);
  }

  // Hold the finished trick on screen so everybody sees what happened.
  room.resolving = true;
  emitAll(room);

  room.timer = setTimeout(() => {
    room.resolving = false;
    room.lastEvent = null;
    if (g.over) {
      finishRound(room);
    } else {
      G.startTrick(g);
      if (g.over) finishRound(room);
      else { emitAll(room); advance(room); }
    }
  }, RESOLVE_MS);

  return {};
}

function finishRound(room) {
  const g = room.game;
  room.phase = "over";
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = 0;
  if (g.bhabhi !== null) {
    const n = room.players[g.bhabhi].name;
    room.tally[n] = (room.tally[n] || 0) + 1;
    sys(room, `Bhabhi: ${n}`);
  } else {
    sys(room, "Round over");
  }
  emitAll(room);
}

const ordinal = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

/* ------------------------------------------------------------------ */
/* Sockets                                                             */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  let roomCode = null;

  const room = () => (roomCode ? rooms.get(roomCode) : null);
  const fail = (msg) => socket.emit("nope", msg);

  socket.on("create", ({ name, token } = {}) => {
    const nm = clean(name, 12) || "Player";
    const tk = clean(token, 64) || crypto.randomUUID();
    const code = newCode();
    const r = makeRoom(code);
    r.hostToken = tk;
    r.players.push({ token: tk, name: nm, bot: false, socketId: socket.id, connected: true });
    rooms.set(code, r);
    roomCode = code;
    socket.join(code);
    sys(r, `${nm} opened the table`);
    socket.emit("joined", { code, token: tk });
    emitAll(r);
  });

  socket.on("join", ({ code, name, token } = {}) => {
    const c = clean(code, 8).toUpperCase();
    const r = rooms.get(c);
    if (!r) return fail("No table with that code.");
    const tk = clean(token, 64) || crypto.randomUUID();

    // Returning player: take the seat back.
    const existing = byToken(r, tk);
    if (existing >= 0) {
      r.players[existing].socketId = socket.id;
      r.players[existing].connected = true;
      roomCode = c;
      socket.join(c);
      sys(r, `${r.players[existing].name} reconnected`);
      socket.emit("joined", { code: c, token: tk });
      emitAll(r);
      advance(r);
      return;
    }

    if (r.phase !== "lobby") return fail("That round is already under way.");
    if (r.players.length >= MAX_SEATS) return fail("That table is full.");

    const nm = clean(name, 12) || "Player";
    r.players.push({ token: tk, name: nm, bot: false, socketId: socket.id, connected: true });
    roomCode = c;
    socket.join(c);
    sys(r, `${nm} sat down`);
    socket.emit("joined", { code: c, token: tk });
    emitAll(r);
  });

  const hostOnly = (r) => {
    const i = bySocket(r, socket.id);
    return i >= 0 && r.players[i].token === r.hostToken;
  };

  socket.on("addBot", () => {
    const r = room();
    if (!r || r.phase !== "lobby" || !hostOnly(r)) return;
    if (r.players.length >= MAX_SEATS) return fail("Table is full.");
    const taken = new Set(r.players.map((p) => p.name));
    const nm = BOT_NAMES.find((n) => !taken.has(n)) || ("Bot" + r.players.length);
    r.players.push({ token: "bot:" + crypto.randomUUID(), name: nm, bot: true, socketId: null, connected: true });
    sys(r, `${nm} joined as a bot`);
    emitAll(r);
  });

  socket.on("removeBot", () => {
    const r = room();
    if (!r || r.phase !== "lobby" || !hostOnly(r)) return;
    for (let i = r.players.length - 1; i >= 0; i--) {
      if (r.players[i].bot) { sys(r, `${r.players[i].name} left`); r.players.splice(i, 1); break; }
    }
    emitAll(r);
  });

  socket.on("start", () => {
    const r = room();
    if (!r || !hostOnly(r)) return;
    if (r.phase === "playing") return;
    if (r.players.length < MIN_SEATS) return fail(`Need at least ${MIN_SEATS} players.`);

    r.game = G.newGame(r.players.map((p) => p.name));
    G.startTrick(r.game);
    r.phase = "playing";
    r.resolving = false;
    r.lastEvent = null;
    sys(r, `Dealt. ${r.players[r.game.leader].name} has the Ace of Spades and leads.`);
    emitAll(r);
    advance(r);
  });

  socket.on("play", ({ card } = {}) => {
    const r = room();
    if (!r || r.phase !== "playing" || r.resolving) return;
    const seat = bySocket(r, socket.id);
    if (seat < 0) return;
    if (!card || typeof card.s !== "string" || typeof card.r !== "number") return fail("Bad card.");
    const res = doPlay(r, seat, { s: card.s, r: card.r }, false);
    if (res.error) {
      fail(res.error);
      socket.emit("state", view(r, seat)); // resync a client that got out of step
    }
  });

  socket.on("chat", ({ text } = {}) => {
    const r = room();
    if (!r) return;
    const seat = bySocket(r, socket.id);
    if (seat < 0) return;
    const msg = clean(text, 140);
    if (!msg) return;
    push(r, { k: "chat", name: r.players[seat].name, msg });
    emitAll(r);
  });

  socket.on("again", () => {
    const r = room();
    if (!r || !hostOnly(r) || r.phase !== "over") return;
    r.game = null;
    r.phase = "lobby";
    r.resolving = false;
    r.lastEvent = null;
    sys(r, "Back to the lobby");
    emitAll(r);
  });

  socket.on("disconnect", () => {
    const r = room();
    if (!r) return;
    const i = bySocket(r, socket.id);
    if (i < 0) return;
    r.players[i].connected = false;
    r.players[i].socketId = null;

    if (r.phase === "lobby") {
      // Nothing is at stake yet — free the seat.
      const was = r.players[i];
      r.players.splice(i, 1);
      sys(r, `${was.name} left`);
      if (was.token === r.hostToken) {
        const next = r.players.find((p) => !p.bot);
        r.hostToken = next ? next.token : null;
        if (next) sys(r, `${next.name} is now host`);
      }
    } else {
      sys(r, `${r.players[i].name} dropped — auto-playing their turns`);
    }

    if (!r.players.some((p) => !p.bot)) {
      clearTimeout(r.timer);
      rooms.delete(r.code);
      return;
    }
    emitAll(r);
    advance(r);
  });
});

// Sweep out abandoned tables.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const live = r.players.some((p) => p.connected && !p.bot);
    if (!live && now - r.touched > EMPTY_ROOM_MS) {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => console.log(`Bhabhi running on http://localhost:${PORT}`));
