// Type declarations for souldial-connector.

/** Web Serial filter for the Soul Dial's USB port (Espressif USB Serial/JTAG). */
export declare const SOULDIAL_USB_FILTERS: ReadonlyArray<{ usbVendorId: number; usbProductId: number }>;
/** `source` value for counters that do not belong to another seat. */
export declare const COUNTER_SOURCE_NONE: 255;
export declare const COUNTER_TYPES: Readonly<{
  POISON: 0; ENERGY: 1; EXPERIENCE: 2; TREASURE: 3; RADIATION: 4; MONARCH: 5;
  INITIATIVE: 6; ASCEND: 7; DAY_NIGHT: 8; COMMANDER_TAX: 9; COMMANDER_DAMAGE: 10;
  MANA_WHITE: 11; MANA_BLUE: 12; MANA_BLACK: 13; MANA_RED: 14; MANA_GREEN: 15;
  MANA_COLORLESS: 16; SHIELD: 17; KO: 18; CUSTOM: 19; STORM: 20; FOOD: 21;
}>;

export type LinkErrorCode = "unsupported" | "invalid" | "timeout" | "closed";
export declare class LinkError extends Error {
  readonly code: LinkErrorCode;
  constructor(code: LinkErrorCode, message?: string);
}

export interface DialCounter {
  /** Position on the Dial (stable while the counter exists). */
  index: number;
  /** One of COUNTER_TYPES. */
  type: number;
  name: string;
  value: number;
  color: string;
  /** Attacker seat for commander damage (seat + 6 for a partner commander); null otherwise. */
  source_player: number | null;
  icon: number;
  flags: number;
  pinned: boolean;
}

export interface DialPlayer {
  index: number;
  name: string;
  life: number;
  color: string;
  knocked_out: boolean;
  /** 1, or 2 with a partner commander; null on firmware without setup. */
  commanders: 1 | 2 | null;
  chess_ms: number;
  total_time_ms: number;
  counters: DialCounter[];
}

/** A validated Dial snapshot (schema "souldial.game-state.v1"). */
export interface DialSnapshot {
  schema: "souldial.game-state.v1";
  num_players: number;
  active_player: number;
  turn_number: number;
  game_type: number;
  game_active: boolean;
  /** True when this firmware takes SoulDialLink.setupGame(). */
  can_setup: boolean;
  /** Starting life of the Dial's current game type; null on older firmware. */
  start_life: number | null;
  /** In a wireless (multi-Dial) game or lobby: setupGame() is refused. */
  wireless: boolean;
  winner_player: number | null;
  timer: { enabled: boolean; running: boolean; mode: number; duration_ms: number; turn_ms: number };
  players: DialPlayer[];
}

export type WriteOp =
  | { kind: "life"; seat: number; value: number; expected?: number | null }
  | {
      kind: "counter";
      seat: number;
      type: number;
      /** Attacker seat for commander damage; COUNTER_SOURCE_NONE (255) otherwise. */
      source?: number;
      value: number;
      expected?: number | null;
      /** Required for custom counters (type 19). */
      index?: number | null;
    };

export type WriteStatus =
  | "ok" | "conflict" | "protected" | "missing" | "no_game" | "no_seat"
  | "not_ready" | "busy" | "unsupported";

export interface SetupPlayer {
  /** Shown on the Dial as printable ASCII, at most 15 characters (see dialName). */
  name: string;
  /** 2 for partner commanders. */
  commanders?: 1 | 2;
}

export type SetupStatus =
  | "ok" | "wireless" | "wrong_game" | "screen" | "failed" | "busy" | "unsupported"
  | "no_game" | "no_seat" | "protected" | "not_ready";

export interface WriteResult {
  status: WriteStatus;
  /** The Dial's value after the request, when it reported one. */
  value?: number;
}

/** Byte transport; webSerialTransport() adapts a Web Serial port. */
export interface Transport {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface LinkOptions {
  /** Snapshot deadline in ms (default 15000). */
  timeoutMs?: number;
  /** Minimum spacing between GAMESTATE requests in ms (default 500, the firmware limit). */
  minSpacingMs?: number;
  /** Request id generator (8 hex digits); for tests. */
  nonce?: () => string;
}

export declare class SoulDialLink {
  /** null until the first write; false when the firmware has no GAMESET (read-only). */
  writeSupported: boolean | null;
  /** Resolves when the read loop ends (disconnect or close). */
  readonly closed: Promise<void>;
  constructor(transport: Transport, options?: LinkOptions);
  /** Opens Chrome's port picker. Call it directly inside a click handler. */
  static requestPort(serial?: unknown): Promise<SerialPortLike>;
  /** Opens the port at 115200 baud and quiets DTR/RTS so closing never resets the Dial. */
  static open(port: SerialPortLike, options?: LinkOptions): Promise<SoulDialLink>;
  /** The latest complete game state. */
  readState(): Promise<DialSnapshot>;
  /** Writes one life or counter value through the Dial's normal, undoable path. */
  write(op: WriteOp): Promise<WriteResult>;
  /**
   * Starts a new local Commander game on the Dial matching a table: one seat per
   * player in this order, the starting life, partner commanders and names. The
   * Dial's game in progress is saved to its Game History first. Refused with
   * "wireless" in a multi-Dial game, "wrong_game" when the Dial is not on Magic,
   * "screen" while a setup page or menu is open on the Dial, and "unsupported"
   * on firmware without setup (check snapshot.can_setup first).
   */
  setupGame(setup: { life?: number; players: SetupPlayer[] }): Promise<{ status: SetupStatus }>;
  close(): Promise<void>;
}

/** The parts of a Web Serial SerialPort this package uses. */
export interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export declare function crc32(bytes: Iterable<number>): number;
export declare function gamesetCommand(
  id: string,
  op: WriteOp | { kind: "setup"; players: number; life: number; commanders?: Array<1 | 2> } | { kind: "seat"; seat: number; name: string },
): string;
/** A name the Dial can show: printable ASCII, accents dropped, at most 15 characters. */
export declare function dialName(name: string | null | undefined, fallback?: string): string;
export declare function publicSnapshot(raw: unknown): DialSnapshot;
/** Lowers RTS, then DTR (the order matters: RTS high with DTR low resets the Dial). */
export declare function quietSignals(port: SerialPortLike): Promise<void>;
export declare function webSerialTransport(port: SerialPortLike): Transport;

// ---- Two-way table sync ----

/** Field keys in Dial seat terms: "life/<seat>", "counter/<seat>/<type>/<source>", "custom/<seat>/<index>". */
export type FieldKey = string;

export interface FieldMeta {
  name?: string;
  type?: number;
  source?: number;
  index?: number;
  color?: string;
}

/** What TableSync needs from an online table. */
export interface TableAdapter {
  /** Current values of the fields this table knows. */
  read(): Map<FieldKey, number>;
  /** Show a Dial value on the table. Resolve false when the table cannot hold that field. */
  write(key: FieldKey, value: number, meta: FieldMeta | null): Promise<boolean>;
  /** Call back on any table change; returns an unsubscribe function. */
  subscribe(callback: () => void): () => void;
}

export type SyncStatus =
  | { state: "linked"; writable: boolean }
  | { state: "error"; error: unknown }
  | { state: "table_error"; key: FieldKey; error: unknown }
  | { state: "write_refused"; key: FieldKey; status: WriteStatus };

export interface TableSyncOptions {
  link: Pick<SoulDialLink, "readState" | "write" | "writeSupported">;
  table: TableAdapter;
  /** Poll interval in ms (default 500). */
  pollMs?: number;
  /** Which side wins the first sync (default "table"). */
  prefer?: "table" | "dial";
  onStatus?: (status: SyncStatus) => void;
  /** false: do not poll; feed snapshots through onDialSnapshot() yourself. */
  autoPoll?: boolean;
}

export declare class TableSync {
  constructor(options: TableSyncOptions);
  /** Last values both sides agreed on. */
  readonly agreed: Map<FieldKey, number>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onDialSnapshot(snapshot: DialSnapshot): Promise<unknown>;
}

export declare function lifeKey(seat: number): FieldKey;
export declare function counterKey(seat: number, type: number, source?: number): FieldKey;
export declare function customKey(seat: number, index: number): FieldKey;
export declare function parseKey(key: FieldKey):
  | { kind: "life"; seat: number }
  | { kind: "counter"; seat: number; type: number; source: number }
  | { kind: "custom"; seat: number; index: number }
  | null;
export declare function dialFields(snapshot: DialSnapshot): Map<FieldKey, { value: number; meta: FieldMeta }>;
