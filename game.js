"use strict";
/**
 * Bhabhi (Thulla) rules engine.
 *
 * Pure state in, pure state out. No DOM, no sockets, no timers.
 * The server is the only thing that ever holds a full game object;
 * clients receive the output of redact() and nothing more.
 */

const SUITS = ["S", "H", "D", "C"];
const GLYPH = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SUITNAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };

const rankLabel = (r) => LABEL[r] || String(r);
const cardName = (c) => rankLabel(c.r) + GLYPH[c.s];
const sameCard = (a, b) => a && b && a.s === b.s && a.r === b.r;

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r });
  return d;
}

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(h) {
  const order = { S: 0, H: 1, D: 2, C: 3 };
  return h.sort((a, b) => order[a.s] - order[b.s] || a.r - b.r);
}

/** Deal a fresh round. `names` sets the seating order. */
function newGame(names, rnd = Math.random) {
  const deck = shuffle(makeDeck(), rnd);
  const hands = names.map(() => []);
  deck.forEach((c, i) => hands[i % names.length].push(c));
  hands.forEach(sortHand);

  const leader = hands.findIndex((h) => h.some((c) => c.s === "S" && c.r === 14));

  return {
    names,
    hands,
    finished: [],   // seats, in the order they emptied out
    trick: [],      // [{seat, card}]
    order: null,    // seats still due to play this trick, in turn order
    idx: 0,
    leadSuit: null,
    leader,
    firstTrick: true,
    over: false,
    bhabhi: null,
  };
}

const activeSeats = (g) =>
  g.hands.map((h, i) => (h.length ? i : -1)).filter((i) => i >= 0);

function startTrick(g) {
  const act = activeSeats(g);
  if (act.length <= 1) {
    g.over = true;
    g.bhabhi = act.length ? act[0] : null;
    g.order = null;
    return;
  }
  if (!act.includes(g.leader)) {
    // The leader went out. Lead passes clockwise to the next player holding cards.
    let n = g.leader;
    do { n = (n + 1) % g.names.length; } while (!g.hands[n].length);
    g.leader = n;
  }
  const start = act.indexOf(g.leader);
  g.order = act.slice(start).concat(act.slice(0, start));
  g.idx = 0;
  g.trick = [];
  g.leadSuit = null;
}

const whoseTurn = (g) => (g.over || !g.order ? null : g.order[g.idx]);

/** Cards this seat may legally play right now. Empty if it isn't their turn. */
function legalCards(g, seat) {
  const hand = g.hands[seat];
  if (whoseTurn(g) !== seat) return [];
  if (g.trick.length === 0) {
    // The opening lead of the round must be the Ace of Spades.
    if (g.firstTrick) return hand.filter((c) => c.s === "S" && c.r === 14);
    return hand.slice();
  }
  const onSuit = hand.filter((c) => c.s === g.leadSuit);
  return onSuit.length ? onSuit : hand.slice(); // void => you may cut with anything
}

/** Highest card of the led suit currently on the table. */
function topOfTrick(g) {
  let best = null;
  for (const p of g.trick) {
    if (p.card.s === g.leadSuit && (!best || p.card.r > best.card.r)) best = p;
  }
  return best;
}

/**
 * Apply one play. Throws on anything illegal — the server calls this on
 * every incoming move, so a tampered client gets rejected here.
 *
 * Returns an event:
 *   {type:"played"}                     trick continues
 *   {type:"clean", winner, cards}       all followed; pile leaves the game
 *   {type:"cut", cutter, eater, cards}  someone was void; eater takes the pile
 */
function playCard(g, seat, card) {
  if (g.over) throw new Error("round is over");
  if (whoseTurn(g) !== seat) throw new Error("not your turn");
  const hand = g.hands[seat];
  const at = hand.findIndex((c) => sameCard(c, card));
  if (at < 0) throw new Error("card not in hand");
  if (!legalCards(g, seat).some((c) => sameCard(c, card))) throw new Error("illegal card");

  const played = hand.splice(at, 1)[0];
  g.trick.push({ seat, card: played });
  if (g.trick.length === 1) g.leadSuit = played.s;

  const followed = played.s === g.leadSuit;
  let ev;

  if (!followed) {
    // A cut ends the trick immediately. Players after this one never play.
    const top = topOfTrick(g);
    const cards = g.trick.map((p) => p.card);
    g.hands[top.seat].push(...cards);
    sortHand(g.hands[top.seat]);
    g.leader = top.seat;
    ev = { type: "cut", cutter: seat, eater: top.seat, cards };
  } else if (g.idx === g.order.length - 1) {
    const top = topOfTrick(g);
    g.leader = top.seat;
    ev = { type: "clean", winner: top.seat, cards: g.trick.map((p) => p.card) };
  } else {
    g.idx++;
    return { type: "played", seat, card: played, outs: [], over: false };
  }

  g.firstTrick = false;

  const outs = [];
  for (const p of g.trick) {
    if (!g.hands[p.seat].length && !g.finished.includes(p.seat)) {
      g.finished.push(p.seat);
      outs.push(p.seat);
    }
  }

  ev.seat = seat;
  ev.card = played;
  ev.outs = outs;

  const act = activeSeats(g);
  if (act.length <= 1) {
    g.over = true;
    g.bhabhi = act.length ? act[0] : null;
    g.order = null;
  }
  ev.over = g.over;
  ev.bhabhi = g.bhabhi;
  return ev;
}

/** Decent heuristic play. Used for bot seats and for auto-play on timeout. */
function botPick(g, seat) {
  const legal = legalCards(g, seat);
  if (!legal.length) return null;
  const hand = g.hands[seat];

  if (g.trick.length === 0) {
    // Lead low, from a suit you're long in. Being top of the led suit is
    // the only way you end up eating the pile.
    const count = {};
    for (const c of hand) count[c.s] = (count[c.s] || 0) + 1;
    let best = legal[0], bestScore = Infinity;
    for (const c of legal) {
      const score = c.r - count[c.s] * 1.6;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  const onSuit = legal[0].s === g.leadSuit;
  if (!onSuit) {
    // Cutting: hand your worst problem card to whoever eats it.
    return legal.reduce((a, b) => (b.r > a.r ? b : a));
  }

  const top = topOfTrick(g);
  if (g.idx === g.order.length - 1) {
    // Last to play and everyone followed — winning is free. Dump the highest.
    return legal.reduce((a, b) => (b.r > a.r ? b : a));
  }
  const under = legal.filter((c) => c.r < top.card.r);
  if (under.length) return under.reduce((a, b) => (b.r > a.r ? b : a));
  return legal.reduce((a, b) => (b.r < a.r ? b : a));
}

/**
 * Build the view one seat is allowed to see. Other players' cards are
 * reduced to a count. This is the only game data that leaves the server.
 */
function redact(g, seat, opts = {}) {
  const turn = whoseTurn(g);
  return {
    seats: g.names.map((n, i) => ({
      seat: i,
      name: n,
      count: g.hands[i].length,
      place: g.finished.indexOf(i),
    })),
    you: seat,
    hand: seat === null || seat === undefined ? [] : g.hands[seat].slice(),
    legal: opts.resolving || seat === null ? [] : legalCards(g, seat),
    trick: g.trick.map((p) => ({ seat: p.seat, card: p.card })),
    leadSuit: g.leadSuit,
    turn,
    leader: g.leader,
    firstTrick: g.firstTrick,
    over: g.over,
    bhabhi: g.bhabhi,
    finished: g.finished.slice(),
    resolving: !!opts.resolving,
  };
}

module.exports = {
  SUITS, GLYPH, LABEL, SUITNAME,
  rankLabel, cardName, sameCard,
  newGame, startTrick, whoseTurn, legalCards, topOfTrick,
  playCard, botPick, activeSeats, redact,
};
