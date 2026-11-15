// Two-way sync between a Soul Dial (SoulDialLink) and any online table.
//
// Both sides are flattened into "fields" keyed in Dial seat terms:
//   life/<seat>                       player life
//   counter/<seat>/<type>/<source>    a typed counter (source 255 = none;
//                                     commander damage uses the attacker seat,
//                                     +6 for a partner commander)
//   custom/<seat>/<index>             a Dial custom counter (by Dial index)
//
// The engine remembers the last value both sides agreed on per field. A Dial
// change is pushed to the table; a table change is written to the Dial with
// if=<agreed>, so a knob turn the table has not seen yet wins (the Dial reports
// conflict and the next poll pushes its value back). Echoes are ignored because
// the echoed value already equals the agreed one.
//
// Table adapter contract (see convoke.js):
//   read()                 -> Map<key, number> of the fields the table knows
//   write(key, value, meta) -> Promise<boolean>; false = table cannot hold it
//   subscribe(callback)     -> unsubscribe function; call on any table change

import { COUNTER_SOURCE_NONE, COUNTER_TYPES } from "./link.js";

export function lifeKey(seat) { return `life/${seat}`; }
export function counterKey(seat, type, source = COUNTER_SOURCE_NONE) { return `counter/${seat}/${type}/${source ?? COUNTER_SOURCE_NONE}`; }
export function customKey(seat, index) { return `custom/${seat}/${index}`; }

export function parseKey(key) {
  const [kind, a, b, c] = String(key).split("/");
  if (kind === "life") return { kind: "life", seat: Number(a) };
  if (kind === "counter") return { kind: "counter", seat: Number(a), type: Number(b), source: Number(c) };
  if (kind === "custom") return { kind: "custom", seat: Number(a), index: Number(b) };
  return null;
}

// Map<key, {value, meta}> from a souldial.game-state.v1 snapshot.
export function dialFields(snapshot) {
  const fields = new Map();
  for (const player of snapshot.players) {
    fields.set(lifeKey(player.index), { value: player.life, meta: { name: player.name } });
    for (const counter of player.counters) {
      const source = counter.source_player ?? COUNTER_SOURCE_NONE;
      const key = counter.type === COUNTER_TYPES.CUSTOM
        ? customKey(player.index, counter.index)
        : counterKey(player.index, counter.type, source);
      if (fields.has(key)) continue; // Duplicate typed counters: the first is canonical.
      fields.set(key, { value: counter.value, meta: { name: counter.name, type: counter.type, source, index: counter.index, color: counter.color } });
    }
  }
  return fields;
}

function writeOp(key, value, expected, dialMeta) {
  const parsed = parseKey(key);
  if (!parsed) return null;
  if (parsed.kind === "life") return { kind: "life", seat: parsed.seat, value, expected };
  if (parsed.kind === "counter") return { kind: "counter", seat: parsed.seat, type: parsed.type, source: parsed.source, value, expected };
  if (!dialMeta) return null; // A custom counter must already exist on the Dial.
  return { kind: "counter", seat: parsed.seat, type: COUNTER_TYPES.CUSTOM, source: dialMeta.source, index: parsed.index, value, expected };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TableSync {
  #link;
  #table;
  #pollMs;
  #prefer;
  #onStatus;
  #agreed = new Map();
  #dial = new Map(); // latest Dial fields
  #tableOnly = new Set(); // keys the Dial refused as missing: leave them on the table
  #running = false;
  #tableDirty = false;
  #tableBusy = null;
  #unsubscribe = null;
  #started = false;
  #autoPoll;

  constructor({ link, table, pollMs = 500, prefer = "table", onStatus = () => {}, autoPoll = true }) {
    this.#autoPoll = autoPoll; // false: the caller feeds onDialSnapshot()
    this.#link = link;
    this.#table = table;
    this.#pollMs = pollMs;
    this.#prefer = prefer; // which side wins the first sync: "table" or "dial"
    this.#onStatus = onStatus;
  }

  get agreed() { return new Map(this.#agreed); }

  async start() {
    if (this.#running) return;
    this.#running = true;
    const first = dialFields(await this.#link.readState());
    this.#dial = first;
    await this.#initialSync(first);
    this.#started = true;
    this.#unsubscribe = this.#table.subscribe(() => this.#scheduleTable());
    this.#onStatus({ state: "linked", writable: this.#link.writeSupported !== false });
    if (this.#autoPoll) this.loop = this.#loop();
  }

  async stop() {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.loop?.catch(() => {});
  }

  async #initialSync(fields) {
    const table = this.#table.read();
    if (this.#prefer === "table") {
      for (const [key, value] of fields) this.#agreed.set(key, value.value);
      for (const [key, value] of table) {
        const dial = fields.get(key);
        if (!dial && parseKey(key)?.kind === "life") continue; // Seat the Dial does not have.
        if ((dial?.value ?? 0) !== value) await this.#writeDial(key, value);
      }
      for (const [key, dial] of fields) if (!table.has(key) && dial.value !== 0) await this.#pushTable(key, dial.value, dial.meta);
    } else {
      for (const [key, dial] of fields) {
        this.#agreed.set(key, dial.value);
        if (table.get(key) !== dial.value) await this.#pushTable(key, dial.value, dial.meta);
      }
      for (const [key, value] of table) if (!fields.has(key) && value !== 0 && parseKey(key)?.kind !== "life") await this.#pushTable(key, 0, null);
    }
  }

  async #loop() {
    while (this.#running) {
      try {
        this.onDialSnapshot(await this.#link.readState());
        if (this.#tableDirty) await this.#scheduleTable();
      } catch (error) {
        this.#onStatus({ state: "error", error });
        if (error?.code === "closed" || error?.code === "unsupported") { this.#running = false; break; }
      }
      await sleep(this.#pollMs);
    }
  }

  // Public for tests and for callers that already poll the Dial themselves.
  onDialSnapshot(snapshot) {
    const fields = dialFields(snapshot);
    const pushes = [];
    for (const [key, dial] of fields) {
      if (this.#agreed.get(key) === dial.value) continue;
      this.#agreed.set(key, dial.value);
      this.#tableOnly.delete(key);
      pushes.push(this.#pushTable(key, dial.value, dial.meta));
    }
    // A counter removed from the Dial reads as zero on the table.
    for (const [key, value] of this.#agreed) {
      if (fields.has(key) || parseKey(key)?.kind === "life" || this.#tableOnly.has(key)) continue;
      if (value !== 0) { this.#agreed.set(key, 0); pushes.push(this.#pushTable(key, 0, null)); }
    }
    this.#dial = fields;
    return Promise.all(pushes);
  }

  async #pushTable(key, value, meta) {
    try {
      await this.#table.write(key, value, meta);
    } catch (error) {
      this.#onStatus({ state: "table_error", key, error });
    }
  }

  #scheduleTable() {
    this.#tableDirty = true;
    if (!this.#started) return Promise.resolve();
    if (!this.#tableBusy) {
      this.#tableBusy = (async () => {
        while (this.#tableDirty) {
          this.#tableDirty = false;
          await this.#onTableChange();
        }
      })().finally(() => { this.#tableBusy = null; });
    }
    return this.#tableBusy;
  }

  async #onTableChange() {
    for (const [key, value] of this.#table.read()) {
      if (this.#tableOnly.has(key)) continue;
      const agreed = this.#agreed.get(key) ?? (this.#dial.has(key) ? this.#dial.get(key).value : (parseKey(key)?.kind === "life" ? undefined : 0));
      if (agreed === undefined || agreed === value) continue;
      await this.#writeDial(key, value);
    }
  }

  async #writeDial(key, value) {
    const dial = this.#dial.get(key);
    const expected = this.#agreed.has(key) ? this.#agreed.get(key) : (dial?.value ?? 0);
    const op = writeOp(key, value, expected, dial?.meta);
    if (!op) { this.#tableOnly.add(key); return; }
    let result;
    try {
      result = await this.#link.write(op);
    } catch (error) {
      this.#onStatus({ state: "error", error });
      return;
    }
    if (result.status === "ok") {
      this.#agreed.set(key, result.value);
      if (result.value !== value) await this.#pushTable(key, result.value, dial?.meta); // Dial clamped it.
    } else if (result.status === "missing") {
      this.#tableOnly.add(key); // e.g. a tracker type this Dial game cannot show.
    } else if (result.status === "protected") {
      if (result.value !== undefined) this.#agreed.set(key, result.value);
      await this.#pushTable(key, this.#agreed.get(key) ?? 0, dial?.meta); // Undo the refused table edit.
    } else if (result.status === "unsupported") {
      this.#onStatus({ state: "linked", writable: false });
    }
    // conflict: the Dial changed first; the next poll pushes the Dial value.
    if (result.status !== "ok") this.#onStatus({ state: "write_refused", key, status: result.status });
  }
}
