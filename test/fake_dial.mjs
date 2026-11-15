// Test double for a Soul Dial's GAMESTATE/GAMESET serial surface: full/delta/
// unchanged envelopes, hex DATA frames, CRC32, GAMESET statuses, if= conflicts
// and no commander life link, as the firmware implements them.
import { crc32 } from "../src/link.js";

const CREATABLE = new Set([0, 1, 2, 3, 4, 9, 20, 21]);

export function makeCounter(index, type, value, source = 255, name = "") {
  return { index, type, name, value, color: "#AABBCC", source_player: source, icon: 0, flags: 0, pinned: true };
}

export function makeGame(lives, { counters = [] } = {}) {
  return {
    schema: 1, num_players: lives.length, active_player: 0, turn_number: 1, game_type: 0, game_active: true,
    winner_player: null, timer: { enabled: false, running: false, mode: 0, duration_ms: 0, turn_ms: 0 },
    players: lives.map((life, index) => ({
      index, name: `P${index + 1}`, life, color: "#112233", knocked_out: false, chess_ms: 0, total_time_ms: 0,
      counters: (counters[index] || []).map((c, i) => makeCounter(i, ...c)),
    })),
  };
}

export class FakeDial {
  constructor(game, { gameset = true, protectedSeats = [] } = {}) {
    this.game = game;
    this.gameset = gameset;
    this.protectedSeats = new Set(protectedSeats);
    this.revision = 0;
    this.sent = null; // last acknowledged snapshot JSON
    this.commands = [];
    this.chunks = [];
    this.waiters = [];
    this.closed = false;
    this.noise = "boot log: Wi-Fi password=hunter2\n";
  }

  // Transport interface
  read() {
    if (this.chunks.length) return Promise.resolve({ value: this.chunks.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async write(bytes) {
    for (const line of new TextDecoder().decode(bytes).split("\n").filter(Boolean)) {
      this.commands.push(line);
      queueMicrotask(() => this.handle(line));
    }
  }
  async close() { this.closed = true; this.flush(); }

  emit(text) {
    this.chunks.push(new TextEncoder().encode(text));
    this.flush();
  }
  flush() {
    while (this.waiters.length && (this.chunks.length || this.closed)) {
      const resolve = this.waiters.shift();
      resolve(this.chunks.length ? { value: this.chunks.shift(), done: false } : { value: undefined, done: true });
    }
  }

  handle(line) {
    const parts = line.split(" ");
    if (parts[0] === "GAMESTATE") return this.gamestate(parts[1], Number(parts[2]));
    if (parts[0] === "GAMESET" && this.gameset) return this.gamesetCommand(parts);
    this.emit(`CMD,ERR,unknown=${line}\n`);
  }

  gamestate(id, base) {
    const current = JSON.stringify(this.game);
    const previous = this.sent ? JSON.parse(this.sent) : null;
    const changed = current !== this.sent;
    const revision = changed ? this.revision + 1 : this.revision || 1;
    let envelope;
    if (!previous || base === 0 || base !== this.revision || previous.num_players !== this.game.num_players) {
      envelope = { schema: 1, revision, base_revision: 0, kind: "full", state: this.game };
    } else if (!changed) {
      envelope = { schema: 1, revision, base_revision: this.revision, kind: "unchanged", state: {} };
    } else {
      const state = {};
      for (const key of ["active_player", "turn_number", "game_type", "game_active", "winner_player"]) {
        if (previous[key] !== this.game[key]) state[key] = this.game[key];
      }
      const players = this.game.players.filter((p, i) => JSON.stringify(p) !== JSON.stringify(previous.players[i]));
      if (players.length) state.players = players;
      envelope = { schema: 1, revision, base_revision: this.revision, kind: "delta", state };
    }
    const payload = new TextEncoder().encode(JSON.stringify(envelope));
    let out = this.noise + `GAMESTATE,BEGIN,id=${id},version=1,bytes=${payload.length}\n`;
    for (let offset = 0; offset < payload.length; offset += 160) {
      const hex = [...payload.slice(offset, offset + 160)].map((b) => b.toString(16).padStart(2, "0")).join("");
      out += `GAMESTATE,DATA,id=${id},offset=${offset},hex=${hex}\n`;
    }
    out += `GAMESTATE,END,id=${id},bytes=${payload.length},crc32=${crc32(payload).toString(16).padStart(8, "0")}\n`;
    this.revision = revision;
    this.sent = current;
    this.emit(out);
  }

  gamesetCommand(parts) {
    const id = parts[1];
    const args = Object.fromEntries(parts.slice(3).map((p) => p.split("=")).map(([k, v]) => [k, Number(v)]));
    const reply = (status, value) => this.emit(status === "ok"
      ? `GAMESET,OK,id=${id},value=${value}\n`
      : `GAMESET,ERR,id=${id},status=${status}${value === undefined ? "" : `,value=${value}`}\n`);
    const player = this.game.players[args.seat];
    if (!player) return reply("no_seat");
    if (parts[2] === "LIFE") {
      if ("if" in args && player.life !== args.if) return reply("conflict", player.life);
      if (player.life !== args.value && this.protectedSeats.has(args.seat)) return reply("protected", player.life);
      player.life = args.value;
      return reply("ok", player.life);
    }
    let counter = "index" in args
      ? player.counters.find((c) => c.index === args.index && c.type === args.type && c.source_player === args.source)
      : player.counters.find((c) => c.type === args.type && c.source_player === args.source);
    if (!counter) {
      if ("if" in args && args.if !== 0) return reply("conflict", 0);
      if (args.value === 0) return reply("ok", 0);
      if ("index" in args || !CREATABLE.has(args.type) || args.source !== 255) return reply("missing");
      counter = { ...makeCounter(player.counters.length, args.type, 0) };
      player.counters.push(counter);
    }
    if ("if" in args && counter.value !== args.if) return reply("conflict", counter.value);
    if (counter.value !== args.value && this.protectedSeats.has(args.seat)) return reply("protected", counter.value);
    counter.value = args.value; // No commander life link on GAMESET.
    return reply("ok", counter.value);
  }
}

// Minimal stand-in for Convoke's GameStateClient: same method names/reducers.
export class FakeConvoke {
  constructor(players) {
    this.state = { players };
    this.listeners = new Set();
    this.calls = [];
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #apply(name, args, mutate) {
    this.calls.push([name, ...args]);
    mutate();
    for (const fn of this.listeners) fn(this.state);
  }
  #p(id) { return this.state.players.find((p) => p.id === id); }
  async setPlayerLife(id, value) { this.#apply("setPlayerLife", [id, value], () => { this.#p(id).life = value; }); }
  async setPoison(id, value) { this.#apply("setPoison", [id, value], () => { this.#p(id).poison = value; }); }
  async setCommanderTax(id, value) { this.#apply("setCommanderTax", [id, value], () => { this.#p(id).commanderTax = value; }); }
  #damage(list, victim, from, amount) {
    const p = this.#p(victim);
    const entries = p[list] || (p[list] = []);
    const entry = entries.find((e) => e.fromPlayerId === from);
    if (entry) entry.amount = amount; else entries.push({ fromPlayerId: from, amount });
  }
  async setCommanderDamage(victim, from, amount) { this.#apply("setCommanderDamage", [victim, from, amount], () => this.#damage("commanderDamageTaken", victim, from, amount)); }
  async setSecondaryCommanderDamage(victim, from, amount) { this.#apply("setSecondaryCommanderDamage", [victim, from, amount], () => this.#damage("secondaryCommanderDamageTaken", victim, from, amount)); }
  async upsertTracker(id, tracker) { this.#apply("upsertTracker", [id, tracker], () => { const p = this.#p(id); (p.trackers || (p.trackers = [])).push({ ...tracker }); }); }
  async setTrackerValue(id, trackerId, value) { this.#apply("setTrackerValue", [id, trackerId, value], () => { this.#p(id).trackers.find((t) => t.id === trackerId).value = value; }); }
}
