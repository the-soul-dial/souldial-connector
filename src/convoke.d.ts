import type { TableAdapter } from "./index.js";

/** Trackers used for Dial counters Convoke has no dedicated field for, keyed by counter type. */
export declare const TRACKER_TYPES: Readonly<Record<number, { id: string; label: string }>>;

/** The parts of Convoke's in-page game state client this adapter uses. */
export interface ConvokeClientLike {
  state: { players?: Array<Record<string, unknown> & { id: unknown }> } | null | undefined;
  subscribe(listener: (state: unknown) => void): () => void;
  setPlayerLife(playerId: unknown, value: number): Promise<void>;
  setPoison(playerId: unknown, value: number): Promise<void>;
  setCommanderTax(playerId: unknown, value: number): Promise<void>;
  setCommanderDamage(victimId: unknown, fromPlayerId: unknown, amount: number, label?: string): Promise<void>;
  setSecondaryCommanderDamage(victimId: unknown, fromPlayerId: unknown, amount: number, label?: string): Promise<void>;
  upsertTracker(playerId: unknown, tracker: { id: string; label: string; value: number }): Promise<void>;
  setTrackerValue(playerId: unknown, trackerId: string, value: number): Promise<void>;
}

/**
 * Adapts Convoke's game state client for TableSync.
 * seats[i] is the Convoke playerId at Dial seat i; unmapped seats are ignored.
 */
export declare function createConvokeTable(client: ConvokeClientLike, options: { seats: unknown[] }): TableAdapter;
