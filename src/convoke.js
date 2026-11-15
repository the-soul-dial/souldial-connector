// Convoke table adapter for TableSync.
//
// Wraps Convoke's in-page game state client (the object exposing
// setPlayerLife / setPoison / setCommanderDamage / upsertTracker / subscribe
// and a `state` with `players`). Built against convoke.games' production bundle
// as of November 2026; Convoke owns that client, so they wire this up in their app:
//
//   const table = createConvokeTable(client, { seats: [aliceId, bobId, ...] });
//   new TableSync({ link, table }).start();
//
// seats[i] is the Convoke playerId sitting at Dial seat i. Unmapped seats are
// ignored in both directions.
//
// Field mapping (Dial -> Convoke):
//   life                         player.life                     setPlayerLife
//   Poison (type 0)              player.poison                   setPoison
//   Commander tax (type 9)       player.commanderTax             setCommanderTax
//   Commander damage (type 10)   commanderDamageTaken[from]      setCommanderDamage
//     partner source (6..11)     secondaryCommanderDamageTaken   setSecondaryCommanderDamage
//   Other numeric counters       trackers id "souldial-<name>"   upsertTracker / setTrackerValue
//   Custom counters              trackers id "souldial-custom-<dial index>"
// Convoke commander damage does not change life, and GAMESET counter writes do
// not apply the Dial's commander life link, so life always travels on its own.

import { COUNTER_SOURCE_NONE, COUNTER_TYPES } from "./link.js";
import { counterKey, customKey, lifeKey, parseKey } from "./table_sync.js";

export const TRACKER_TYPES = Object.freeze({
  [COUNTER_TYPES.ENERGY]: { id: "souldial-energy", label: "Energy" },
  [COUNTER_TYPES.EXPERIENCE]: { id: "souldial-experience", label: "Experience" },
  [COUNTER_TYPES.TREASURE]: { id: "souldial-treasure", label: "Treasure" },
  [COUNTER_TYPES.RADIATION]: { id: "souldial-radiation", label: "Radiation" },
  [COUNTER_TYPES.STORM]: { id: "souldial-storm", label: "Storm" },
  [COUNTER_TYPES.FOOD]: { id: "souldial-food", label: "Food" },
});
const CUSTOM_PREFIX = "souldial-custom-";
const PARTNER_BASE = 6;

function trackerForType(type) {
  return TRACKER_TYPES[type] || null;
}

function typeForTracker(id) {
  for (const [type, tracker] of Object.entries(TRACKER_TYPES)) if (tracker.id === id) return Number(type);
  return null;
}

export function createConvokeTable(client, { seats }) {
  const seatOf = (playerId) => seats.indexOf(playerId);
  const player = (seat) => {
    const id = seats[seat];
    return id === undefined || id === null ? null : (client.state?.players || []).find((p) => p.id === id) || null;
  };

  function read() {
    const fields = new Map();
    seats.forEach((id, seat) => {
      const p = player(seat);
      if (!p) return;
      if (typeof p.life === "number") fields.set(lifeKey(seat), p.life);
      fields.set(counterKey(seat, COUNTER_TYPES.POISON), p.poison ?? 0);
      fields.set(counterKey(seat, COUNTER_TYPES.COMMANDER_TAX), p.commanderTax ?? 0);
      for (const [list, offset] of [[p.commanderDamageTaken, 0], [p.secondaryCommanderDamageTaken, PARTNER_BASE]]) {
        for (const entry of list || []) {
          const from = seatOf(entry.fromPlayerId);
          if (from >= 0) fields.set(counterKey(seat, COUNTER_TYPES.COMMANDER_DAMAGE, from + offset), entry.amount ?? 0);
        }
      }
      for (const tracker of p.trackers || []) {
        const id = String(tracker.id);
        const type = typeForTracker(id);
        if (type !== null) fields.set(counterKey(seat, type), Number(tracker.value) || 0);
        else if (id.startsWith(CUSTOM_PREFIX)) fields.set(customKey(seat, Number(id.slice(CUSTOM_PREFIX.length))), Number(tracker.value) || 0);
      }
    });
    return fields;
  }

  async function upsertTracker(playerId, id, label, value) {
    const exists = (client.state?.players || []).find((p) => p.id === playerId)?.trackers?.some((t) => String(t.id) === id);
    if (exists) await client.setTrackerValue(playerId, id, value);
    else await client.upsertTracker(playerId, { id, label, value });
  }

  async function write(key, value, meta) {
    const field = parseKey(key);
    const playerId = field ? seats[field.seat] : undefined;
    if (!field || playerId === undefined || playerId === null || !player(field.seat)) return false;
    if (field.kind === "life") {
      await client.setPlayerLife(playerId, value);
      return true;
    }
    if (field.kind === "custom") {
      await upsertTracker(playerId, `${CUSTOM_PREFIX}${field.index}`, meta?.name || "Counter", value);
      return true;
    }
    switch (field.type) {
      case COUNTER_TYPES.POISON:
        await client.setPoison(playerId, value);
        return true;
      case COUNTER_TYPES.COMMANDER_TAX:
        await client.setCommanderTax(playerId, value);
        return true;
      case COUNTER_TYPES.COMMANDER_DAMAGE: {
        if (field.source === COUNTER_SOURCE_NONE) return false;
        const partner = field.source >= PARTNER_BASE;
        const fromId = seats[partner ? field.source - PARTNER_BASE : field.source];
        if (fromId === undefined || fromId === null) return false;
        if (partner) await client.setSecondaryCommanderDamage(playerId, fromId, value);
        else await client.setCommanderDamage(playerId, fromId, value);
        return true;
      }
      default: {
        const tracker = trackerForType(field.type);
        if (!tracker || field.source !== COUNTER_SOURCE_NONE) return false;
        await upsertTracker(playerId, tracker.id, meta?.name || tracker.label, value);
        return true;
      }
    }
  }

  return {
    read,
    write,
    subscribe: (callback) => client.subscribe(() => callback()),
  };
}
