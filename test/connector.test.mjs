// npm test
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SoulDialLink, crc32, gamesetCommand, COUNTER_TYPES } from "../src/link.js";
import { TableSync, dialFields, counterKey, lifeKey } from "../src/table_sync.js";
import { createConvokeTable } from "../src/convoke.js";
import { FakeDial, FakeConvoke, makeGame } from "./fake_dial.mjs";

const T = COUNTER_TYPES;
const fastLink = (dial, options = {}) => new SoulDialLink(dial, { minSpacingMs: 0, timeoutMs: 1000, ...options });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("crc32 matches zlib", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("gamesetCommand formats and bounds every field", () => {
  assert.equal(gamesetCommand("ABCD1234", { kind: "life", seat: 2, value: -5, expected: 7 }),
    "GAMESET ABCD1234 LIFE seat=2 value=-5 if=7");
  assert.equal(gamesetCommand("ABCD1234", { kind: "counter", seat: 0, type: 10, source: 7, value: 21 }),
    "GAMESET ABCD1234 COUNTER seat=0 type=10 source=7 value=21");
  assert.equal(gamesetCommand("ABCD1234", { kind: "counter", seat: 1, type: 19, source: 255, index: 4, value: 3 }),
    "GAMESET ABCD1234 COUNTER seat=1 type=19 source=255 value=3 index=4");
  assert.throws(() => gamesetCommand("ABCD1234", { kind: "life", seat: 6, value: 1 }), RangeError);
  assert.throws(() => gamesetCommand("ABCD1234", { kind: "counter", seat: 0, type: 10, source: 12, value: 1 }), RangeError);
  assert.throws(() => gamesetCommand("ABCD1234", { kind: "life", seat: 0, value: 40000 }), RangeError);
});

test("readState assembles full, unchanged and delta snapshots and ignores logs", async () => {
  const dial = new FakeDial(makeGame([40, 40], { counters: [[[T.POISON, 2]]] }));
  const link = fastLink(dial);
  const first = await link.readState();
  assert.equal(first.players[0].life, 40);
  assert.equal(first.players[0].counters[0].source_player, null);
  assert.deepEqual(await link.readState(), first);
  dial.game.players[1].life = 33;
  const third = await link.readState();
  assert.equal(third.players[1].life, 33);
  assert.equal(third.players[0].counters[0].value, 2);
  assert.match(dial.commands.at(-1), /^GAMESTATE [0-9A-F]{8} 1$/);
  assert.equal(JSON.stringify(third).includes("hunter2"), false);
  await link.close();
});

test("a corrupted frame forces one fresh full request", async () => {
  const dial = new FakeDial(makeGame([20]));
  const link = fastLink(dial);
  await link.readState();
  dial.game.players[0].life = 19;
  const original = dial.gamestate.bind(dial);
  let corrupt = true;
  dial.gamestate = (id, base) => {
    if (corrupt) { corrupt = false; dial.emit(`GAMESTATE,BEGIN,id=${id},version=1,bytes=2\nGAMESTATE,DATA,id=${id},offset=0,hex=7b7d\nGAMESTATE,END,id=${id},bytes=2,crc32=00000000\n`); return; }
    original(id, base);
  };
  await assert.rejects(link.readState(), { code: "invalid" });
  assert.equal((await link.readState()).players[0].life, 19);
  await link.close();
});

test("write reports ok, conflict and old-firmware unsupported", async () => {
  const dial = new FakeDial(makeGame([40, 40]));
  const link = fastLink(dial);
  assert.deepEqual(await link.write({ kind: "life", seat: 1, value: 35, expected: 40 }), { status: "ok", value: 35 });
  assert.deepEqual(await link.write({ kind: "life", seat: 1, value: 30, expected: 40 }), { status: "conflict", value: 35 });
  await link.close();

  const old = new FakeDial(makeGame([40]), { gameset: false });
  const oldLink = fastLink(old);
  assert.deepEqual(await oldLink.write({ kind: "life", seat: 0, value: 1 }), { status: "unsupported" });
  assert.equal(oldLink.writeSupported, false);
  assert.equal((await oldLink.readState()).players[0].life, 40); // Reading still works.
  await oldLink.close();
});

test("unknown GAMESTATE command reports unsupported firmware", async () => {
  const dial = new FakeDial(makeGame([40]));
  dial.handle = (line) => dial.emit(`CMD,ERR,unknown=${line}\n`);
  await assert.rejects(fastLink(dial).readState(), { code: "unsupported" });
});

test("dialFields keys commander damage by attacker seat and custom by index", () => {
  const game = makeGame([40, 40], { counters: [[[T.COMMANDER_DAMAGE, 5, 1], [T.COMMANDER_DAMAGE, 2, 7], [T.CUSTOM, 3, 255, "Rad"]]] });
  const link = new FakeDial(game);
  const fields = dialFields({ players: game.players.map((p) => ({ ...p, counters: p.counters.map((c) => ({ ...c, source_player: c.source_player === 255 ? null : c.source_player })) })) });
  assert.equal(fields.get("counter/0/10/1").value, 5);
  assert.equal(fields.get("counter/0/10/7").value, 2);
  assert.equal(fields.get("custom/0/2").value, 3);
  link.close();
});

function convokeTable(lives) {
  return new FakeConvoke(lives.map((life, i) => ({ id: 100 + i, life, poison: 0, commanderTax: 0, commanderDamageTaken: [], trackers: [] })));
}

async function linked(dialGame, convoke, options = {}) {
  const dial = new FakeDial(dialGame, options.dial);
  const link = fastLink(dial);
  const table = createConvokeTable(convoke, { seats: convoke.state.players.map((p) => p.id) });
  const statuses = [];
  const sync = new TableSync({ link, table, pollMs: 1, prefer: options.prefer || "table", autoPoll: false, onStatus: (s) => statuses.push(s) });
  await sync.start();
  return { dial, link, sync, statuses };
}

async function poll(sync, link) {
  await sync.onDialSnapshot(await link.readState());
  await settle();
}

test("first sync takes the online table's totals onto the Dial", async () => {
  const convoke = convokeTable([31, 40, 22]);
  convoke.state.players[0].commanderDamageTaken.push({ fromPlayerId: 102, amount: 9 });
  const { dial, link, sync } = await linked(makeGame([40, 40, 40]), convoke);
  await sync.stop();
  await link.close();
  assert.deepEqual(dial.game.players.map((p) => p.life), [31, 40, 22]);
  assert.equal(dial.game.players[0].counters.length, 0, "commander damage counters are matrix-owned; fake has none, so missing");
});

test("Dial knob changes reach Convoke and are not echoed back", async () => {
  const convoke = convokeTable([40, 40]);
  const { dial, link, sync } = await linked(makeGame([40, 40]), convoke);
  convoke.calls.length = 0;
  dial.commands.length = 0;
  dial.game.players[1].life = 34;
  dial.game.players[1].counters.push({ index: 0, type: T.COMMANDER_DAMAGE, name: "", value: 6, color: "#AABBCC", source_player: 0, icon: 0, flags: 0, pinned: true });
  dial.game.players[0].counters.push({ index: 0, type: T.ENERGY, name: "Energy", value: 3, color: "#AABBCC", source_player: 255, icon: 0, flags: 0, pinned: true });
  await poll(sync, link);
  assert.equal(convoke.state.players[1].life, 34);
  assert.deepEqual(convoke.state.players[1].commanderDamageTaken, [{ fromPlayerId: 100, amount: 6 }]);
  assert.deepEqual(convoke.state.players[0].trackers, [{ id: "souldial-energy", label: "Energy", value: 3 }]);
  assert.equal(dial.commands.filter((c) => c.startsWith("GAMESET")).length, 0, "no echo writes");
  await sync.stop();
  await link.close();
});

test("Convoke changes reach the Dial with if= and without the commander life link", async () => {
  const convoke = convokeTable([40, 40]);
  const { dial, link, sync } = await linked(makeGame([40, 40], { counters: [[], [[T.COMMANDER_DAMAGE, 0, 0]]] }), convoke);
  await convoke.setCommanderDamage(101, 100, 7);
  await convoke.setPoison(100, 2);
  await settle();
  await sync.onDialSnapshot(await link.readState());
  assert.equal(dial.game.players[1].counters[0].value, 7);
  assert.equal(dial.game.players[1].life, 40, "commander damage alone never moves life");
  assert.equal(dial.game.players[0].counters.find((c) => c.type === T.POISON).value, 2);
  assert.ok(dial.commands.includes(dial.commands.find((c) => /COUNTER seat=1 type=10 source=0 value=7 if=0$/.test(c))));
  const writes = convoke.calls.length;
  await poll(sync, link);
  assert.equal(convoke.calls.length, writes, "Dial confirmation is not echoed to Convoke");
  await sync.stop();
  await link.close();
});

test("a knob turn the table has not seen wins over a stale table edit", async () => {
  const convoke = convokeTable([40]);
  const { dial, link, sync } = await linked(makeGame([40]), convoke);
  dial.game.players[0].life = 38; // Turned on the Dial, not yet polled.
  await convoke.setPlayerLife(100, 30);
  await settle();
  assert.equal(dial.game.players[0].life, 38, "GAMESET if=40 refused as conflict");
  await poll(sync, link);
  assert.equal(convoke.state.players[0].life, 38);
  await sync.stop();
  await link.close();
});

test("a protected seat reverts the table edit", async () => {
  const convoke = convokeTable([40, 40]);
  const { dial, link, sync, statuses } = await linked(makeGame([40, 40]), convoke, { dial: { protectedSeats: [1] } });
  await convoke.setPlayerLife(101, 12);
  await settle();
  assert.equal(dial.game.players[1].life, 40);
  assert.equal(convoke.state.players[1].life, 40);
  assert.ok(statuses.some((s) => s.state === "write_refused" && s.status === "protected"));
  await sync.stop();
  await link.close();
});

test("prefer dial pushes the Dial's totals to the table on first sync", async () => {
  const convoke = convokeTable([40, 40]);
  convoke.state.players[0].poison = 4;
  const { link, sync } = await linked(makeGame([17, 25]), convoke, { prefer: "dial" });
  assert.deepEqual(convoke.state.players.map((p) => p.life), [17, 25]);
  assert.equal(convoke.state.players[0].poison, 0);
  await sync.stop();
  await link.close();
});

test("real firmware GAMESTATE frames parse in the browser link", { skip: !hostHarness() }, async () => {
  const frames = execFileSync(hostHarness(), { timeout: 30000 }).toString("latin1");
  const nonces = ["ABCD1234", "00000005", "00000006", "00000007", "00000008"];
  const groups = nonces.map((nonce) => frames.split("\n").filter((line) => line.includes(`,id=${nonce},`)).join("\n") + "\n");
  let call = 0;
  const transport = new FakeDial(makeGame([1]));
  transport.handle = () => transport.emit(groups[call++]);
  const link = fastLink(transport, { nonce: () => nonces[call] });
  const first = await link.readState();
  assert.equal(first.num_players, 6);
  assert.equal(first.players[0].life, -12);
  assert.equal(first.players[0].name, 'A"\\UTF8é');
  assert.equal((await link.readState()).players[0].life, 313);
  await link.readState();
  assert.equal((await link.readState()).players[2].counters[0].value, 7);
  await link.close();
});

function hostHarness() {
  // Optional: path to a firmware host build that prints real GAMESTATE frames.
  const exe = process.env.SOULDIAL_GAMESTATE_HOST;
  return exe && existsSync(exe) ? exe : null;
}

test("life keys exist only for mapped seats", () => {
  const convoke = convokeTable([40, 40]);
  const table = createConvokeTable(convoke, { seats: [101] });
  const fields = table.read();
  assert.equal(fields.get(lifeKey(0)), 40);
  assert.equal(fields.has(lifeKey(1)), false);
  assert.equal(fields.get(counterKey(0, T.POISON)), 0);
});

test("open lowers RTS before DTR so closing never resets the Dial", async () => {
  const calls = [];
  const dial = new FakeDial(makeGame([40]));
  const port = {
    async open(options) { calls.push(["open", options.baudRate]); },
    async setSignals(signals) { calls.push(["signals", signals]); },
    async close() { calls.push(["close"]); },
    readable: { getReader: () => ({ read: () => dial.read(), cancel: async () => { dial.closed = true; dial.flush(); }, releaseLock() {} }) },
    writable: { getWriter: () => ({ write: (bytes) => dial.write(bytes), releaseLock() {} }) },
  };
  const link = await SoulDialLink.open(port, { minSpacingMs: 0 });
  assert.deepEqual(calls, [["open", 115200], ["signals", { requestToSend: false }], ["signals", { dataTerminalReady: false }]]);
  assert.equal((await link.readState()).players[0].life, 40);
  await link.close();
  assert.deepEqual(calls.slice(3), [["signals", { requestToSend: false }], ["signals", { dataTerminalReady: false }], ["close"]]);
});

test("Convoke tracker ids can be renamed or switched off without editing the package", async () => {
  const convoke = convokeTable([40]);
  const table = createConvokeTable(convoke, { seats: [100], trackers: { [T.ENERGY]: { id: "energy", label: "Energy" }, [T.STORM]: null } });
  assert.equal(await table.write(counterKey(0, T.ENERGY), 3, null), true);
  assert.deepEqual(convoke.state.players[0].trackers, [{ id: "energy", label: "Energy", value: 3 }]);
  assert.equal(table.read().get(counterKey(0, T.ENERGY)), 3);
  assert.equal(await table.write(counterKey(0, T.STORM), 2, null), false);
  assert.equal(await table.write(counterKey(0, T.TREASURE), 1, null), true); // defaults still apply
});
