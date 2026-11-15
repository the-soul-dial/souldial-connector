// Soul Dial USB game link for browsers (Web Serial).
//
// Read half:  GAMESTATE <id> <base_revision>  -> checksummed full/delta/unchanged snapshot
// Write half: GAMESET <id> LIFE|COUNTER ...    -> one gameplay value through the Dial's
//                                                 normal protected/synced/undoable path
// Speaks the Soul Dial firmware's physical-USB GAMESTATE and GAMESET services.
// No dependencies; works in Chrome/Edge (navigator.serial) and in Node tests via a
// fake transport.

export const SOULDIAL_USB_FILTERS = [{ usbVendorId: 0x303a, usbProductId: 0x1001 }];
export const COUNTER_SOURCE_NONE = 255;
export const COUNTER_TYPES = Object.freeze({
  POISON: 0, ENERGY: 1, EXPERIENCE: 2, TREASURE: 3, RADIATION: 4, MONARCH: 5,
  INITIATIVE: 6, ASCEND: 7, DAY_NIGHT: 8, COMMANDER_TAX: 9, COMMANDER_DAMAGE: 10,
  MANA_WHITE: 11, MANA_BLUE: 12, MANA_BLACK: 13, MANA_RED: 14, MANA_GREEN: 15,
  MANA_COLORLESS: 16, SHIELD: 17, KO: 18, CUSTOM: 19, STORM: 20, FOOD: 21,
});

const MAX_SNAPSHOT_BYTES = 65536;
const MAX_LINE_BYTES = 512;
const MIN_REQUEST_SPACING_MS = 500; // Firmware refuses GAMESTATE inside 500 ms.
const WRITE_TIMEOUT_MS = 3000;
const PLAYER_KEYS = new Set(["index", "name", "life", "color", "knocked_out", "chess_ms", "total_time_ms", "counters"]);
const DELTA_KEYS = new Set(["num_players", "active_player", "turn_number", "game_type", "game_active", "winner_player", "timer", "players"]);

export class LinkError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "LinkError";
    this.code = code; // unsupported | invalid | timeout | closed
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function nonce() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function int(value, low, high) {
  if (!Number.isInteger(value) || value < low || value > high) throw new LinkError("invalid");
  return value;
}

function bool(value) {
  if (typeof value !== "boolean") throw new LinkError("invalid");
  return value;
}

function color(value) {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) throw new LinkError("invalid");
  return value.toUpperCase();
}

function text(value, fallback) {
  const clean = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : "";
  return clean || fallback;
}

// Validated, allowlisted snapshot in the same shape as the PC mirror's
// souldial.game-state.v1 JSON (source_player 255 becomes null).
export function publicSnapshot(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== 1) throw new LinkError("invalid");
  const count = int(raw.num_players, 1, 6);
  if (!Array.isArray(raw.players) || raw.players.length !== count) throw new LinkError("invalid");
  const players = raw.players.map((player, index) => {
    int(player.index, index, index);
    if (!Array.isArray(player.counters) || player.counters.length > 32) throw new LinkError("invalid");
    const seen = new Set();
    const counters = player.counters.map((counter) => {
      const counterIndex = int(counter.index, 0, 31);
      if (seen.has(counterIndex)) throw new LinkError("invalid");
      seen.add(counterIndex);
      const source = int(counter.source_player, 0, 255);
      if (source !== COUNTER_SOURCE_NONE && source > 11) throw new LinkError("invalid");
      return {
        index: counterIndex,
        type: int(counter.type, 0, 22),
        name: text(counter.name, `Counter ${counterIndex + 1}`),
        value: int(counter.value, -2147483648, 2147483647),
        color: color(counter.color),
        source_player: source === COUNTER_SOURCE_NONE ? null : source,
        icon: int(counter.icon, 0, 255),
        flags: int(counter.flags, 0, 255),
        pinned: bool(counter.pinned),
      };
    });
    return {
      index,
      name: text(player.name, `Player ${index + 1}`),
      life: int(player.life, -32768, 32767),
      color: color(player.color),
      knocked_out: bool(player.knocked_out),
      chess_ms: int(player.chess_ms, 0, 0xffffffff),
      total_time_ms: int(player.total_time_ms, 0, 0xffffffff),
      counters,
    };
  });
  const timer = raw.timer || {};
  return {
    schema: "souldial.game-state.v1",
    num_players: count,
    active_player: int(raw.active_player, 0, count - 1),
    turn_number: int(raw.turn_number, 0, 0xffffffff),
    game_type: int(raw.game_type, 0, 11),
    game_active: bool(raw.game_active),
    winner_player: raw.winner_player === null ? null : int(raw.winner_player, 0, count - 1),
    timer: {
      enabled: bool(timer.enabled),
      running: bool(timer.running),
      mode: int(timer.mode, 0, 3),
      duration_ms: int(timer.duration_ms, 0, 43200000),
      turn_ms: int(timer.turn_ms, 0, 0xffffffff),
    },
    players,
  };
}

// Chrome opens with DTR and RTS asserted, and port.close() (also on tab close or
// navigation) drops them. On the Dial's USB Serial/JTAG, RTS high with DTR low
// is the chip-reset state, so a bare close, or clearing both lines in one
// setSignals(), reboots the Dial (verified on hardware). Lower RTS first,
// then DTR, right after open: the lines then stay idle and closing is harmless.
export async function quietSignals(port) {
  await port.setSignals({ requestToSend: false });
  await port.setSignals({ dataTerminalReady: false });
}

export function webSerialTransport(port) {
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  return {
    read: () => reader.read(),
    write: (bytes) => writer.write(bytes),
    async close() {
      try { await reader.cancel(); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
      try { writer.releaseLock(); } catch { /* ignore */ }
      try { await quietSignals(port); } catch { /* unplugged */ }
      try { await port.close(); } catch { /* unplugged */ }
    },
  };
}

export class SoulDialLink {
  #transport;
  #listeners = new Set();
  #queue = Promise.resolve();
  #closed = false;
  #revision = 0;
  #state = null;
  #lastRequestAt = -Infinity;
  #timeoutMs;
  #spacingMs;
  #nonce;
  writeSupported = null; // null = unknown, false = firmware has GAMESTATE only

  constructor(transport, { timeoutMs = 15000, minSpacingMs = MIN_REQUEST_SPACING_MS, nonce: makeNonce = nonce } = {}) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
    this.#spacingMs = minSpacingMs;
    this.#nonce = makeNonce;
    this.closed = this.#pump();
  }

  // Must run inside a click handler (Web Serial user activation): never await first.
  static requestPort(serial = globalThis.navigator?.serial) {
    if (!serial) return Promise.reject(new LinkError("unsupported", "This browser has no Web Serial. Use Chrome or Edge on a computer."));
    return serial.requestPort({ filters: SOULDIAL_USB_FILTERS });
  }

  static async open(port, options) {
    await port.open({ baudRate: 115200, bufferSize: 4096 });
    try {
      await quietSignals(port);
    } catch (error) {
      try { await port.close(); } catch { /* ignore */ }
      throw error;
    }
    return new SoulDialLink(webSerialTransport(port), options);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
  }

  async #pump() {
    const decoder = new TextDecoder();
    let line = "";
    let dropping = false;
    try {
      while (!this.#closed) {
        const { value, done } = await this.#transport.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const ch of chunk) {
          if (ch !== "\n") {
            if (dropping) continue;
            line += ch;
            if (line.length > MAX_LINE_BYTES) { line = ""; dropping = true; }
            continue;
          }
          if (dropping) { dropping = false; continue; }
          const complete = line.replace(/\r$/, "");
          line = "";
          // Only protocol frames are dispatched; logs never reach callers.
          if (complete.startsWith("GAMESTATE,") || complete.startsWith("GAMESET,") || complete.startsWith("CMD,ERR,unknown=GAME")) {
            for (const listener of [...this.#listeners]) listener(complete);
          }
        }
      }
    } catch (error) {
      if (!this.#closed) this.#fail(new LinkError("closed", "The Soul Dial USB connection was lost."));
      return;
    }
    this.#fail(new LinkError("closed", "The Soul Dial USB connection closed."));
  }

  #fail(error) {
    this.#closed = true;
    for (const listener of [...this.#listeners]) listener(null, error);
  }

  // One request on the wire at a time keeps replies and spacing simple.
  #serial(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  #exchange(command, onLine, timeoutMs) {
    if (this.#closed) return Promise.reject(new LinkError("closed", "The Soul Dial is not connected."));
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
        fn(value);
      };
      const listener = (line, error) => {
        if (error) return finish(reject, error);
        try {
          const result = onLine(line);
          if (result !== undefined) finish(resolve, result);
        } catch (failure) {
          finish(reject, failure);
        }
      };
      const timer = setTimeout(() => finish(reject, new LinkError("timeout", "The Soul Dial did not answer. Check the USB cable and firmware.")), timeoutMs);
      this.#listeners.add(listener);
      this.#transport.write(new TextEncoder().encode(`${command}\n`)).catch((error) => finish(reject, new LinkError("closed", error?.message)));
    });
  }

  // Latest complete game state (souldial.game-state.v1 shape).
  readState() {
    return this.#serial(async () => {
      try {
        return await this.#readEnvelope(this.#revision);
      } catch (error) {
        if (error?.code !== "refresh") throw error;
        this.#revision = 0;
        this.#state = null;
        return this.#readEnvelope(0, true);
      }
    });
  }

  async #readEnvelope(base, requireFull = false) {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const wait = this.#lastRequestAt + this.#spacingMs - Date.now();
      if (wait > 0) await delay(wait);
      this.#lastRequestAt = Date.now();
      const reply = await this.#gamestateOnce(base, Math.max(1, deadline - Date.now()));
      if (reply !== "retry") return this.#applyEnvelope(reply, requireFull);
      if (Date.now() >= deadline) throw new LinkError("timeout", "No game snapshot received.");
    }
  }

  #gamestateOnce(base, timeoutMs) {
    const id = this.#nonce();
    const command = `GAMESTATE ${id} ${base}`;
    let expected = null;
    let bytes = [];
    return this.#exchange(command, (line) => {
      if (line === "CMD,ERR,unknown=GAMESTATE" || line === `CMD,ERR,unknown=${command}`) {
        throw new LinkError("unsupported", "This Soul Dial needs a firmware update for the game link.");
      }
      if (line === "GAMESTATE,ERR,id=00000000,status=bad_request") throw new LinkError("invalid");
      if (!line.includes(`,id=${id},`)) return undefined;
      let m;
      if ((m = line.match(new RegExp(`^GAMESTATE,ERR,id=${id},status=(busy|no_memory|not_ready|bad_request)$`)))) {
        if (m[1] === "bad_request") throw new LinkError("invalid");
        return "retry";
      }
      if ((m = line.match(new RegExp(`^GAMESTATE,BEGIN,id=${id},version=1,bytes=([0-9]+)$`)))) {
        if (expected !== null) throw new LinkError("invalid");
        expected = Number(m[1]);
        if (expected < 1 || expected > MAX_SNAPSHOT_BYTES) throw new LinkError("invalid");
        return undefined;
      }
      if ((m = line.match(new RegExp(`^GAMESTATE,DATA,id=${id},offset=([0-9]+),hex=([0-9A-Fa-f]+)$`)))) {
        if (expected === null || Number(m[1]) !== bytes.length || m[2].length % 2 || m[2].length > 320) throw new LinkError("invalid");
        for (let i = 0; i < m[2].length; i += 2) bytes.push(parseInt(m[2].slice(i, i + 2), 16));
        if (bytes.length > expected) throw new LinkError("invalid");
        return undefined;
      }
      if ((m = line.match(new RegExp(`^GAMESTATE,END,id=${id},bytes=([0-9]+),crc32=([0-9A-Fa-f]{8})$`)))) {
        const payload = Uint8Array.from(bytes);
        if (expected === null || Number(m[1]) !== expected || payload.length !== expected || crc32(payload) !== parseInt(m[2], 16)) {
          throw new LinkError("invalid");
        }
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        } catch {
          throw new LinkError("invalid");
        }
      }
      throw new LinkError("invalid");
    }, timeoutMs);
  }

  #applyEnvelope(envelope, requireFull) {
    const refresh = () => new LinkError("refresh");
    try {
      if (!envelope || envelope.schema !== 1 || typeof envelope.state !== "object" || !envelope.state) throw refresh();
      const revision = int(envelope.revision, 1, 0xffffffff);
      const base = int(envelope.base_revision, 0, 0xffffffff);
      const { kind, state } = envelope;
      if (requireFull && kind !== "full") throw refresh();
      let candidate;
      if (kind === "full") {
        if (base !== 0) throw refresh();
        candidate = state;
      } else if (kind === "unchanged") {
        if (Object.keys(state).length || !this.#state || base !== this.#revision || revision !== this.#revision) throw refresh();
        return publicSnapshot(this.#state);
      } else if (kind === "delta") {
        if (!this.#state || base !== this.#revision || revision <= base) throw refresh();
        if (Object.keys(state).some((key) => !DELTA_KEYS.has(key))) throw refresh();
        candidate = structuredClone(this.#state);
        for (const [key, value] of Object.entries(state)) if (key !== "players") candidate[key] = value;
        if ("players" in state) {
          if (!Array.isArray(state.players)) throw refresh();
          const seen = new Set();
          for (const player of state.players) {
            const index = int(player.index, 0, candidate.players.length - 1);
            if (seen.has(index) || Object.keys(player).some((key) => !PLAYER_KEYS.has(key))) throw refresh();
            seen.add(index);
            Object.assign(candidate.players[index], player);
          }
        }
      } else {
        throw refresh();
      }
      const snapshot = publicSnapshot(candidate);
      this.#state = candidate;
      this.#revision = revision;
      return snapshot;
    } catch (error) {
      if (error?.code === "refresh" || error?.code === "invalid") throw refresh();
      throw error;
    }
  }

  // op: { kind: "life", seat, value, expected? }
  //  or { kind: "counter", seat, type, source (255 = none), value, expected?, index? }
  // Resolves { status, value? }: ok | conflict | protected | missing | no_game |
  // no_seat | not_ready | unsupported. value is the Dial's value after the write.
  write(op) {
    return this.#serial(async () => {
      if (this.writeSupported === false) return { status: "unsupported" };
      const command = gamesetCommand(this.#nonce(), op);
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await this.#gamesetOnce(command);
        if (result.status !== "busy") {
          if (result.status === "unsupported") this.writeSupported = false;
          else this.writeSupported = true;
          return result;
        }
        await delay(100 * (attempt + 1));
      }
      return { status: "busy" };
    });
  }

  #gamesetOnce(command) {
    const id = command.split(" ")[1];
    return this.#exchange(command, (line) => {
      if (line === "CMD,ERR,unknown=GAMESET" || line === `CMD,ERR,unknown=${command}`) return { status: "unsupported" };
      if (line === "GAMESET,ERR,id=00000000,status=bad_request") throw new LinkError("invalid", "The Soul Dial refused a malformed GAMESET.");
      let m;
      if ((m = line.match(new RegExp(`^GAMESET,OK,id=${id},value=(-?[0-9]+)$`)))) return { status: "ok", value: Number(m[1]) };
      if ((m = line.match(new RegExp(`^GAMESET,ERR,id=${id},status=([a-z_]+)(?:,value=(-?[0-9]+))?$`)))) {
        return m[2] === undefined ? { status: m[1] } : { status: m[1], value: Number(m[2]) };
      }
      return undefined;
    }, WRITE_TIMEOUT_MS);
  }
}

function checkInt(value, low, high, name) {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError(`GAMESET ${name} out of range`);
  return value;
}

export function gamesetCommand(id, op) {
  const parts = ["GAMESET", id];
  if (op.kind === "life") {
    parts.push("LIFE", `seat=${checkInt(op.seat, 0, 5, "seat")}`, `value=${checkInt(op.value, -32767, 32767, "value")}`);
  } else if (op.kind === "counter") {
    const source = op.source ?? COUNTER_SOURCE_NONE;
    if (source !== COUNTER_SOURCE_NONE) checkInt(source, 0, 11, "source");
    parts.push("COUNTER", `seat=${checkInt(op.seat, 0, 5, "seat")}`, `type=${checkInt(op.type, 0, 21, "type")}`,
      `source=${source}`, `value=${checkInt(op.value, -32767, 32767, "value")}`);
    if (op.index !== undefined && op.index !== null) parts.push(`index=${checkInt(op.index, 0, 31, "index")}`);
  } else {
    throw new TypeError("GAMESET kind must be life or counter");
  }
  if (op.expected !== undefined && op.expected !== null) parts.push(`if=${checkInt(op.expected, -32768, 32767, "if")}`);
  return parts.join(" ");
}
