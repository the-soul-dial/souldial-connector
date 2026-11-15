# Soul Dial + Convoke integration guide

This guide is for Convoke's developers. It adds a **Connect Soul Dial** button
to a Convoke game, so a player's USB Soul Dial and the Convoke table stay in
step both ways: life totals, poison, commander damage (including partners),
commander tax and other counters.

## What players get

- Turn the Dial, and the Convoke table updates in under a second.
- Change life or counters on Convoke (or another player does), and the Dial
  updates too.
- A knob turn and a website click never overwrite each other or bounce back
  and forth. If they happen together, the Dial's value wins.
- Unplugging, disconnecting or closing the tab is safe. The Dial keeps its game.

## Requirements

- Chrome or Edge on a desktop/laptop (Web Serial). Hide or disable the button
  when `"serial" in navigator` is false (Safari, Firefox, phones).
- Your site on HTTPS (or `http://localhost` while developing).
- A Soul Dial with a USB **data** cable.
- Dial firmware:
  - Dial → Convoke works on current Soul Dial firmware with game streaming.
  - Convoke → Dial needs firmware with remote game updates (the next Soul
    Dial update). Older firmware is detected: the link reports
    `writable: false`, and only Dial → Convoke works. A message like "Update
    your Soul Dial to send changes back to it" is enough.

## Install

```bash
npm install github:the-soul-dial/souldial-connector#v0.1.1 --allow-git=root
```

(npm 12+ needs `--allow-git=root` for GitHub installs. The handoff zip also
includes the same package as a `.tgz`: `npm install ./souldial-connector-0.1.1.tgz`.)

No runtime dependencies; ES modules with TypeScript types.

## Wire it up

The adapter talks to your in-page game state client: the object with
`setPlayerLife`, `setPoison`, `setCommanderTax`, `setCommanderDamage`,
`setSecondaryCommanderDamage`, `upsertTracker`, `setTrackerValue`,
`subscribe()` and `state.players`. We built it against those method names on
convoke.games in November 2026. If you rename any, the adapter is one small
file (`src/convoke.js`) to adjust.

### React

`examples/useSoulDial.js` is a ready hook:

```jsx
import { useSoulDial } from "./useSoulDial";

function SoulDialButton({ gameStateClient }) {
  const dial = useSoulDial(gameStateClient);
  if (!dial.supported) return null;
  if (dial.status.state === "linked") {
    return <button onClick={dial.disconnect}>Soul Dial linked{dial.status.writable ? "" : " (one-way)"}</button>;
  }
  return <button onClick={() => dial.connect()}>Connect Soul Dial</button>;
}
```

### Without React

```js
import { SoulDialLink, TableSync } from "souldial-connector";
import { createConvokeTable } from "souldial-connector/convoke";

button.addEventListener("click", () => {
  SoulDialLink.requestPort().then(async (port) => { // no await before this line
    const link = await SoulDialLink.open(port);
    const table = createConvokeTable(gameStateClient, {
      seats: gameStateClient.state.players.map((p) => p.id),
    });
    const sync = new TableSync({ link, table, prefer: "table", onStatus: console.log });
    await sync.start();
  });
});
```

Always open the port with `SoulDialLink.open()`. A plain `port.open()` /
`port.close()` from Chrome resets the Dial and ends its game.

## Seats

The Dial tracks players by seat (0-5) in its own order. `seats[i]` is the
Convoke `playerId` sitting at Dial seat `i`.

- **Default:** Convoke's player order. That works when players set the Dial up
  with the same player count and order as the Convoke table.
- **Better:** after connecting, show the Dial's player names (`dialPlayers` in
  the hook, or `(await link.readState()).players`) next to Convoke's players,
  let the player match them once, then start the sync with that mapping.
- Seats you leave out are ignored in both directions. A Dial with fewer players
  than the table only links the seats it has.

Each remote player can link their own Dial. Every Dial then mirrors the whole
table, and an edit on any Dial reaches everyone through Convoke.

## Who may connect

Only participants. Spectator clients are read-only (`isReadOnly()`), so their
writes are blocked anyway. Hide the button for spectators.

## First sync

`prefer: "table"` (recommended for Convoke) puts Convoke's current totals onto
the Dial when the player connects. `prefer: "dial"` does the reverse. Use it if
you offer "I've been tracking on my Dial" as an option.

## Field mapping

| Dial | Convoke |
|---|---|
| Life | `player.life` / `setPlayerLife` |
| Poison | `player.poison` / `setPoison` |
| Commander tax | `player.commanderTax` / `setCommanderTax` |
| Commander damage (from seat `s`) | `commanderDamageTaken[fromPlayerId = seats[s]]` / `setCommanderDamage` |
| Partner commander damage | `secondaryCommanderDamageTaken` / `setSecondaryCommanderDamage` |
| Energy, Experience, Treasure, Radiation, Storm, Food | tracker `souldial-energy`, `souldial-experience`, … |
| Custom counters made on the Dial | tracker `souldial-custom-<index>` |

Commander damage never changes life by itself in either direction. Life is
synced as its own value, so commander damage is never counted twice.

If Convoke has native fields for Energy and the like, change `TRACKER_TYPES`
in `src/convoke.js` (or map them in a copy of the adapter) instead of the
`souldial-*` trackers.

Not linked yet: player count and names, passing the turn, timers, and Monarch /
Initiative / Day-Night.

## Status and messages

`onStatus` (and the hook's `status`) reports:

| Status | Suggested player message |
|---|---|
| `linked`, `writable: true` | "Soul Dial linked" |
| `linked`, `writable: false` | "Soul Dial linked (one-way). Update your Soul Dial to send changes back to it." |
| `error` (timeout / closed) | "Soul Dial disconnected. Check the USB cable and connect again." |
| `start()` rejects with code `unsupported` | "This Soul Dial needs a firmware update to connect." |
| `write_refused` `protected` | Nothing needed: a Dial in a local wireless game refused a seat it doesn't own, and Convoke's value is put back. |
| `write_refused` `no_game` | "Start a game on your Soul Dial." |

The Dial's port picker lists only Soul Dials (USB `303A:1001`). If the list is
empty, the cable is probably charge-only or the Dial is plugged into the wrong
port.

## Try it without touching Convoke

The package has a demo page with a mock table that uses this same adapter:

```bash
npm run demo
```

Open http://127.0.0.1:8743 in Chrome, start a game on the Dial, click Connect,
and change values on either side.

## Support

Questions or issues: https://github.com/the-soul-dial/souldial-connector/issues
