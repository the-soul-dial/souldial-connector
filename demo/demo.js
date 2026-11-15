// Bench/demo page for the Soul Dial table link. The mock client below has the
// same method names and state shape as Convoke's game state client, so this
// page exercises createConvokeTable + TableSync exactly as an integration would.
import { SoulDialLink, TableSync, COUNTER_TYPES as T } from "../src/index.js";
import { createConvokeTable } from "../src/convoke.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(text) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${text}\n${logEl.textContent}`.slice(0, 20000);
}
function status(text, bad = false) {
  $("status").textContent = text;
  $("status").className = bad ? "bad" : "";
}

class MockTableClient {
  constructor(count) {
    this.state = { players: Array.from({ length: count }, (_, i) => ({
      id: 1001 + i, name: `Player ${i + 1}`, life: 40, poison: 0, commanderTax: 0,
      commanderDamageTaken: [], secondaryCommanderDamageTaken: [], trackers: [],
    })) };
    this.listeners = new Set();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #p(id) { return this.state.players.find((p) => p.id === id); }
  #emit() { renderTable(); for (const fn of this.listeners) fn(this.state); }
  async setPlayerLife(id, v) { this.#p(id).life = v; this.#emit(); }
  async setPoison(id, v) { this.#p(id).poison = Math.max(0, v); this.#emit(); }
  async setCommanderTax(id, v) { this.#p(id).commanderTax = Math.max(0, v); this.#emit(); }
  #damage(list, victim, from, amount) {
    const entries = this.#p(victim)[list];
    const entry = entries.find((e) => e.fromPlayerId === from);
    if (entry) entry.amount = Math.max(0, amount); else entries.push({ fromPlayerId: from, amount: Math.max(0, amount) });
    this.#emit();
  }
  async setCommanderDamage(v, f, a) { this.#damage("commanderDamageTaken", v, f, a); }
  async setSecondaryCommanderDamage(v, f, a) { this.#damage("secondaryCommanderDamageTaken", v, f, a); }
  async upsertTracker(id, tracker) { this.#p(id).trackers.push({ ...tracker }); this.#emit(); }
  async setTrackerValue(id, trackerId, v) { this.#p(id).trackers.find((t) => t.id === trackerId).value = v; this.#emit(); }
}

let client = new MockTableClient(4);
let link = null;
let sync = null;

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderTable() {
  const root = $("table");
  root.replaceChildren();
  for (const p of client.state.players) {
    const box = document.createElement("div");
    box.className = "player";
    const head = document.createElement("div");
    head.className = "row";
    const life = document.createElement("span");
    life.className = "life";
    life.textContent = p.life;
    head.append(life, button("−5", () => client.setPlayerLife(p.id, p.life - 5)), button("−1", () => client.setPlayerLife(p.id, p.life - 1)),
      button("+1", () => client.setPlayerLife(p.id, p.life + 1)), document.createTextNode(` ${p.name}`));
    const counters = document.createElement("div");
    counters.className = "row";
    counters.append(chip(`Poison ${p.poison}`), button("+", () => client.setPoison(p.id, p.poison + 1)), button("−", () => client.setPoison(p.id, p.poison - 1)));
    for (const from of client.state.players) {
      if (from.id === p.id) continue;
      const amount = p.commanderDamageTaken.find((e) => e.fromPlayerId === from.id)?.amount ?? 0;
      counters.append(chip(`Cmdr ${from.name.replace("Player ", "P")}: ${amount}`), button("+", () => client.setCommanderDamage(p.id, from.id, amount + 1)));
    }
    for (const t of p.trackers) counters.append(chip(`${t.label} ${t.value}`));
    box.append(head, counters);
    root.append(box);
  }
}

function chip(text) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = text;
  return span;
}

function renderDial(snapshot) {
  const root = $("dial");
  root.replaceChildren();
  for (const p of snapshot.players) {
    const box = document.createElement("div");
    box.className = "player";
    const head = document.createElement("div");
    head.className = "row";
    const life = document.createElement("span");
    life.className = "life";
    life.textContent = p.life;
    head.append(life, document.createTextNode(` ${p.name}${p.index === snapshot.active_player ? "  (turn)" : ""}`));
    const counters = document.createElement("div");
    counters.className = "row";
    for (const c of p.counters) {
      if (!c.pinned && c.value === 0) continue;
      // The Dial already names commander damage counters after the attacker.
      const from = c.type === T.COMMANDER_DAMAGE && c.source_player !== null && !/^cmdr/i.test(c.name)
        ? ` from P${(c.source_player % 6) + 1}${c.source_player >= 6 ? "b" : ""}` : "";
      counters.append(chip(`${c.name}${from}: ${c.value}`));
    }
    box.append(head, counters);
    root.append(box);
  }
}

$("players").addEventListener("change", () => {
  if (sync) return;
  client = new MockTableClient(Number($("players").value));
  renderTable();
});

$("connect").addEventListener("click", () => {
  // requestPort must start inside the click: do not await anything first.
  SoulDialLink.requestPort().then(async (port) => {
    $("connect").disabled = true;
    status("Connecting…");
    link = await SoulDialLink.open(port);
    const tapped = {
      readState: async () => { const s = await link.readState(); renderDial(s); return s; },
      write: async (op) => { const r = await link.write(op); log(`Dial ← ${JSON.stringify(op)} → ${r.status}${r.value === undefined ? "" : ` (${r.value})`}`); return r; },
      get writeSupported() { return link.writeSupported; },
    };
    const table = createConvokeTable(client, { seats: client.state.players.map((p) => p.id) });
    sync = new TableSync({
      link: tapped, table, prefer: $("prefer").value,
      onStatus: (s) => {
        if (s.state === "linked") status(s.writable ? "Linked both ways" : "Linked (Dial → table only: update the Dial firmware for two-way)", !s.writable);
        else if (s.state === "error") { status(s.error?.message || "Connection problem", true); log(`Error: ${s.error?.message}`); }
        else if (s.state === "write_refused") log(`Dial refused ${s.key}: ${s.status}`);
      },
    });
    await sync.start();
    $("disconnect").disabled = false;
    log("Linked");
  }).catch((error) => {
    $("connect").disabled = false;
    if (error?.name !== "NotFoundError") { status(error?.message || String(error), true); log(`Error: ${error?.message || error}`); }
  });
});

$("disconnect").addEventListener("click", async () => {
  await sync?.stop();
  await link?.close();
  sync = link = null;
  $("connect").disabled = false;
  $("disconnect").disabled = true;
  status("Not connected");
});

renderTable();
