"use strict";
/**
 * Rules-engine test. Plays thousands of full rounds at every table size and
 * asserts the invariants that matter. Run with: npm test
 */
const G = require("./game");

const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff);

let games = 0, cuts = 0, cleans = 0, lengths = [];
const problems = {};
const bad = (m) => { problems[m] = (problems[m] || 0) + 1; };

for (let n = 3; n <= 6; n++) {
  for (let t = 0; t < 1200; t++) {
    const names = Array.from({ length: n }, (_, i) => "P" + i);
    const g = G.newGame(names, seeded(t * 97 + n * 7919 + 1));

    if (g.hands.reduce((a, h) => a + h.length, 0) !== 52) bad("deck is not 52 cards");
    if (g.leader < 0) bad("nobody holds the Ace of Spades");

    G.startTrick(g);

    // The opening lead must be the Ace of Spades and nothing else.
    const first = G.legalCards(g, G.whoseTurn(g));
    if (first.length !== 1 || first[0].s !== "S" || first[0].r !== 14) bad("opening lead not forced to A-spades");

    let tricks = 0, guard = 0;
    while (!g.over) {
      if (++guard > 20000) { bad("round never terminated"); break; }
      const seat = G.whoseTurn(g);
      if (seat === null) { bad("no seat to play while round is live"); break; }

      const legal = G.legalCards(g, seat);
      if (!legal.length) { bad("a live seat had no legal card"); break; }

      if (g.trick.length) {
        const onSuit = g.hands[seat].filter((c) => c.s === g.leadSuit);
        if (onSuit.length && legal.some((c) => c.s !== g.leadSuit)) bad("allowed a cut while holding the suit");
        if (!onSuit.length && legal.length !== g.hands[seat].length) bad("void seat not allowed its whole hand");
      }

      const card = G.botPick(g, seat);
      if (!legal.some((c) => G.sameCard(c, card))) bad("bot chose an illegal card");

      // an illegal move must always be refused
      const illegal = g.hands[seat].find((c) => !legal.some((l) => G.sameCard(l, c)));
      if (illegal) {
        let threw = false;
        try { G.playCard({ ...g, hands: g.hands.map((h) => h.slice()) }, seat, illegal); } catch (e) { threw = true; }
        if (!threw) bad("engine accepted an illegal card");
      }

      const ev = G.playCard(g, seat, card);
      if (ev.type === "cut") {
        cuts++;
        if (g.hands[ev.eater].length < ev.cards.length) bad("eater did not receive the pile");
      }
      if (ev.type === "clean") cleans++;

      if (ev.type !== "played") {
        tricks++;
        if (!g.over) G.startTrick(g);
      }
    }

    if (!g.over) { bad("round did not finish"); continue; }
    const act = G.activeSeats(g);
    if (act.length > 1) bad("finished with more than one player holding cards");
    if (g.bhabhi !== null && !g.hands[g.bhabhi].length) bad("bhabhi holds no cards");
    if (g.bhabhi !== null && g.finished.includes(g.bhabhi)) bad("bhabhi also listed as safe");
    if (new Set(g.finished).size !== g.finished.length) bad("a seat finished twice");
    if (g.bhabhi !== null && g.finished.length !== n - 1) bad("wrong number of finishers");

    // redaction must never expose another seat's cards
    const v = G.redact(g, 0);
    if (JSON.stringify(v).includes('"hands"')) bad("redacted view exposed raw hands");
    if (v.seats.some((s) => s.cards)) bad("redacted view exposed opponent cards");

    lengths.push(tricks);
    games++;
  }
}

lengths.sort((a, b) => a - b);
console.log(`rounds played: ${games}`);
console.log(`cuts: ${cuts}   clean tricks: ${cleans}`);
console.log(`tricks per round — median ${lengths[Math.floor(lengths.length / 2)]}, max ${lengths[lengths.length - 1]}`);
const keys = Object.keys(problems);
if (keys.length) { console.error("FAILURES:", problems); process.exit(1); }
console.log("all engine checks passed");
