// souldial-connector/react: React hook that links a USB Soul Dial with a Convoke game.
//
//   import { useSoulDial } from "souldial-connector/react";
//   const dial = useSoulDial(gameStateClient);
//   <button onClick={() => dial.connect()} disabled={!dial.supported}>Connect Soul Dial</button>
//
// connect() must be called directly from the click handler (Web Serial needs the
// user's click to open the port picker). React 18+ is a peer dependency.
import { useCallback, useEffect, useRef, useState } from "react";
import { SoulDialLink, TableSync } from "./index.js";
import { createConvokeTable } from "./convoke.js";

/**
 * @param {object} client Convoke's game state client (setPlayerLife, setPoison, ..., subscribe, state).
 * @param {object} [options]
 * @param {"table" | "dial"} [options.prefer] Which totals win when linking (default "table": the online game).
 */
export function useSoulDial(client, { prefer = "table" } = {}) {
  const [status, setStatus] = useState({ state: "idle" });
  const [dialPlayers, setDialPlayers] = useState([]);
  const session = useRef(null);
  const supported = typeof navigator !== "undefined" && "serial" in navigator;

  const disconnect = useCallback(async () => {
    const current = session.current;
    session.current = null;
    await current?.sync?.stop();
    await current?.link?.close(); // Safe: the link already quieted DTR/RTS, so the Dial does not reset.
    setStatus({ state: "idle" });
  }, []);

  /**
   * Opens the port picker and links the Dial.
   * @param {Array<unknown>} [seats] Convoke playerId for each Dial seat, in Dial order.
   *   Defaults to Convoke's player order.
   */
  const connect = useCallback((seats) => {
    if (session.current) return Promise.resolve();
    // No await before requestPort(): it must run inside the click.
    return SoulDialLink.requestPort().then(async (port) => {
      setStatus({ state: "connecting" });
      const link = await SoulDialLink.open(port);
      session.current = { link, sync: null };
      const snapshot = await link.readState();
      setDialPlayers(snapshot.players.map((p) => ({ seat: p.index, name: p.name })));
      const mapping = seats ?? (client.state?.players ?? []).map((p) => p.id);
      const sync = new TableSync({
        link,
        table: createConvokeTable(client, { seats: mapping }),
        prefer,
        onStatus: (s) => {
          if (s.state === "linked") setStatus({ state: "linked", writable: s.writable });
          else if (s.state === "error") setStatus({ state: "error", message: s.error?.message ?? "Soul Dial connection problem" });
        },
      });
      session.current.sync = sync;
      await sync.start();
    }).catch(async (error) => {
      if (error?.name === "NotFoundError") return; // The player closed the picker.
      await disconnect();
      setStatus({ state: "error", message: error?.message ?? String(error) });
    });
  }, [client, prefer, disconnect]);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  return {
    supported, // false on Safari, Firefox and phones
    status,    // idle | connecting | linked {writable} | error {message}
    dialPlayers, // [{seat, name}] from the Dial, for a seat-matching UI
    connect,
    disconnect,
  };
}
