import type { ConvokeClientLike } from "./convoke.js";

export type SoulDialStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "linked"; writable: boolean }
  | { state: "error"; message: string };

export interface UseSoulDial {
  /** false on Safari, Firefox and phones (no Web Serial). */
  supported: boolean;
  status: SoulDialStatus;
  /** The Dial's players, for a seat-matching UI (filled after connect). */
  dialPlayers: Array<{ seat: number; name: string }>;
  /**
   * Opens the port picker and links the Dial. Call it directly from a click handler.
   * seats[i] is the Convoke playerId at Dial seat i; defaults to Convoke's player order.
   */
  connect(seats?: unknown[]): Promise<void>;
  disconnect(): Promise<void>;
}

/** Links a USB Soul Dial with a Convoke game; disconnects on unmount. */
export declare function useSoulDial(
  client: ConvokeClientLike,
  options?: { prefer?: "table" | "dial" },
): UseSoulDial;
