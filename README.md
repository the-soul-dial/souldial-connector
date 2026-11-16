# souldial-connector

Connect a USB **Soul Dial** life counter to your web app. Players plug their
Dial into a computer, click a button, and life totals, commander damage and
counters stay in step between the Dial and your site — in both directions.

- **Dial → your app:** read the game in real time (about every 0.5 s).
- **Your app → Dial:** set life or a counter; the Dial applies it like a knob
  turn (undoable, and shared with other Dials in a local wireless game).
- **Two-way sync engine** with conflict handling, so a knob turn and a website
  click never overwrite each other or bounce back and forth.
- No dependencies. Plain ES modules with TypeScript types.

Runs in **Chrome and Edge on desktop** (Web Serial). Safari, Firefox and phones
do not support Web Serial.

## Install

```bash
npm install "git+https://github.com/the-soul-dial/souldial-connector.git"
```

npm 12 and later refuse dependencies from Git unless the project allows them:
add `allow-git=root` to your project's `.npmrc`. Older npm, pnpm and Yarn need
no setting. `npm update souldial-connector` pulls the latest release.

Or load it straight from a CDN, no build step:

```js
import { SoulDialLink, TableSync } from "https://cdn.jsdelivr.net/gh/the-soul-dial/souldial-connector/src/index.js";
```

## Quick start: read and write

```js
import { SoulDialLink } from "souldial-connector";

connectButton.addEventListener("click", () => {
  // requestPort() must run directly inside the click: don't await anything first.
  SoulDialLink.requestPort().then(async (port) => {
    const dial = await SoulDialLink.open(port);

    const game = await dial.readState();
    console.log(game.players.map((p) => `${p.name}: ${p.life}`));

    // Set seat 2's life to 35, only if it is still 40 on the Dial.
    const result = await dial.write({ kind: "life", seat: 1, value: 35, expected: 40 });
    console.log(result); // { status: "ok", value: 35 }
  });
});
```

Always open the port with `SoulDialLink.open()` (see [USB safety](#usb-safety)).

## Two-way sync with your table

`TableSync` keeps the Dial and your game state matched. You provide a small
adapter for your table:

```js
import { SoulDialLink, TableSync, lifeKey, counterKey, parseKey, COUNTER_TYPES } from "souldial-connector";

const table = {
  // Every value your table knows, keyed in Dial seat terms.
  read() {
    const fields = new Map();
    myGame.players.forEach((p, seat) => {
      fields.set(lifeKey(seat), p.life);
      fields.set(counterKey(seat, COUNTER_TYPES.POISON), p.poison);
    });
    return fields;
  },
  // Show a Dial value on your table. Return false for fields you don't support.
  async write(key, value) {
    const field = parseKey(key);
    if (field.kind === "life") { myGame.setLife(field.seat, value); return true; }
    if (field.kind === "counter" && field.type === COUNTER_TYPES.POISON) { myGame.setPoison(field.seat, value); return true; }
    return false;
  },
  // Call back whenever your table changes (including remote players' changes).
  subscribe(callback) { return myGame.onChange(callback); },
};

const sync = new TableSync({
  link: await SoulDialLink.open(port),
  table,
  prefer: "table",               // first sync: your table's totals go onto the Dial
  onStatus: (s) => console.log(s),
});
await sync.start();
// later: await sync.stop();
```

### Field keys

| Key | Meaning |
|---|---|
| `life/<seat>` | Player life |
| `counter/<seat>/<type>/<source>` | A counter. `type` is a `COUNTER_TYPES` value; `source` is `255` for none, or the attacker's seat for commander damage (`seat + 6` for a partner commander) |
| `custom/<seat>/<index>` | A custom counter created on the Dial |

Seats are the Dial's player order (0-based). Let players match their Dial
seats to your players once when they connect.

### How conflicts resolve

- The engine remembers the last value both sides agreed on. Table changes are
  written to the Dial with `expected` set to that value.
- If someone turned the Dial in the meantime, the Dial answers `conflict` and
  the Dial's value is pushed to your table. **The Dial wins races.**
- `protected` (a seat this Dial may not edit, e.g. owned by another Dial in a
  local wireless game) reverts the table edit.
- `missing` (a counter the Dial won't add remotely, see below) leaves your
  table's value alone and stops retrying that field.
- Firmware without write support still syncs Dial → table;
  `onStatus` reports `{ state: "linked", writable: false }`.
- Undo on the Dial also undoes changes that came from your site, and syncs the
  undo back.

The Dial adds simple per-player counters on request (Poison, Energy,
Experience, Treasure, Radiation, Commander tax, Storm, Food). It does not add
table-wide or on/off counters (Monarch, Initiative, Day/Night), commander
damage in a game without commander damage, or counters in custom game types.

## Convoke adapter

Full guide: [docs/convoke.md](docs/convoke.md). React: `import { useSoulDial } from "souldial-connector/react"`.

`souldial-connector/convoke` wraps Convoke's in-page game state client:

```js
import { SoulDialLink, TableSync } from "souldial-connector";
import { createConvokeTable } from "souldial-connector/convoke";

const table = createConvokeTable(gameStateClient, {
  seats: [aliceId, bobId, carolId, daveId], // Dial seat i -> Convoke playerId
});
await new TableSync({ link: await SoulDialLink.open(port), table }).start();
```

| Dial | Convoke |
|---|---|
| Life | `player.life` / `setPlayerLife` |
| Poison | `player.poison` / `setPoison` |
| Commander tax | `player.commanderTax` / `setCommanderTax` |
| Commander damage | `commanderDamageTaken` / `setCommanderDamage` |
| Partner commander damage | `secondaryCommanderDamageTaken` / `setSecondaryCommanderDamage` |
| Energy, Experience, Treasure, Radiation, Storm, Food | tracker `souldial-<name>` |
| Custom counters | tracker `souldial-custom-<index>` |

Commander damage never changes life by itself in either direction: life is
always synced as its own field, so it is never counted twice.

## API

From `souldial-connector`:

- `SoulDialLink.requestPort()` — open the browser's port picker (filtered to Soul Dials).
- `SoulDialLink.open(port, options?)` — open and return a link.
- `link.readState()` → `DialSnapshot` — players, life, counters, turn, timer.
- `link.write(op)` → `{ status, value? }` — `op` is
  `{ kind: "life", seat, value, expected? }` or
  `{ kind: "counter", seat, type, source?, value, expected?, index? }`.
- `link.setupGame({ life?, players })` → `{ status }` — starts a new Commander
  game on the Dial that matches your table: one seat per player in the order
  given, the starting life (default 40), partner commanders
  (`players: [{ name, commanders?: 1 | 2 }]`) and each player's name. The game
  in progress on the Dial is saved to its history first. Check
  `snapshot.can_setup` before offering it; see *Setting up the Dial* below.
- `link.writeSupported` — `false` once the Dial reports it cannot accept writes.
- `link.close()`.
- `new TableSync({ link, table, prefer?, pollMs?, onStatus?, autoPoll? })`, `.start()`, `.stop()`.
- Helpers: `lifeKey`, `counterKey`, `customKey`, `parseKey`, `dialFields`,
  `COUNTER_TYPES`, `COUNTER_SOURCE_NONE`, `SOULDIAL_USB_FILTERS`, `LinkError`,
  `dialName` (a name as the Dial will show it), `pageConnectors`, `CONNECTOR_VERSION`.

From `souldial-connector/convoke`: `createConvokeTable(client, { seats, trackers? })`, `TRACKER_TYPES`.

From `souldial-connector/react` (React 18+, optional peer dependency):
`useSoulDial(convokeClient, { prefer? })` → `{ supported, status, dialPlayers, connect(seats?), disconnect }`.

Write statuses: `ok`, `conflict`, `protected`, `missing`, `no_game` (the Dial
is not in a game), `no_seat`, `not_ready`, `busy`, `unsupported`.

Full types are in [`src/index.d.ts`](src/index.d.ts).

## Setting up the Dial

Instead of asking players to match Dial seats to your table, you can set the
Dial up from the table:

```js
const state = await link.readState();
if (state.can_setup && !state.wireless) {
  const { status } = await link.setupGame({
    players: table.players.map((p) => ({ name: p.name, commanders: p.partner ? 2 : 1 })),
  });
  if (status === "ok") {
    const sync = new TableSync({ link, table: createTable(table.players.map((p) => p.id)), prefer: "table" });
    await sync.start();
  }
}
```

Dial seat *i* is then table player *i*. Names are shown as printable ASCII, at
most 15 characters (accents are dropped). The Dial refuses setup with
`wireless` while it is in a multi-Dial game, `wrong_game` when it is not on
Magic: The Gathering, and `screen` while a setup page or menu is open on it;
`unsupported` means its firmware predates setup. If the page reloads, compare
`state.players` names with `dialName(name)` before setting up again, so a game
already running for your table is not restarted.

## Sharing a page with the Soul Dial Link extension

Players may also have the Soul Dial Link Chrome extension, which brings the
Dial to several online tables, yours included. The two never fight over the
Dial:

- Your copy of this package announces itself on the page. While it is there,
  the extension stays out of the way and points players to your own Soul Dial
  button.
- Only one connection holds the Dial at a time. If the extension was
  connected first, `SoulDialLink.open()` from your page takes the Dial over;
  the extension's link closes with `LinkError` code `yielded`.
- `pageConnectors()` lists the copies on the page and which one holds the
  Dial. Opening while another holds it fails with code `in_use`.

You don't need to do anything for this beyond installing the package.

## USB safety

Chrome opens serial ports with the DTR and RTS lines on and switches them off
when the port closes — including when the tab closes or navigates away. On the
Dial's USB port, one combination of those lines resets the Dial, which would
end the game. `SoulDialLink.open()` switches RTS off and then DTR right after
opening, so disconnecting is always safe. If you open the port yourself, call
`quietSignals(port)` immediately after `port.open()`, and never switch both
lines off in a single `setSignals()` call.

## Requirements

- Chrome or Edge on Windows, macOS, Linux or ChromeOS, served over HTTPS or
  `http://localhost`.
- A Soul Dial connected with a USB data cable.
- Reading needs Soul Dial firmware with game streaming; writing needs firmware
  with remote game updates. Older firmware is detected and reported.

## Demo

A test page that pairs a real Dial with a mock online table:

```bash
npm run demo
```

Open http://127.0.0.1:8743 in Chrome, start a game on the Dial, connect, and
change values on either side.

## Wire protocol

115200 baud on the Dial's USB port (VID `0x303A`, PID `0x1001`), one command
per line. Lines that are not `GAMESTATE,` / `GAMESET,` frames are device logs;
ignore them.

Reading: `GAMESTATE <id> <base_revision>` returns a CRC32-checked JSON snapshot
in hex frames (`BEGIN` / `DATA` / `END`): a full state, a delta against
`base_revision`, or `unchanged`. At most one request per 500 ms.

Writing:

```
GAMESET <id> LIFE seat=<0-5> value=<v> [if=<expected>]
GAMESET <id> COUNTER seat=<0-5> type=<0-21> source=<0-11|255> value=<v> [if=<expected>] [index=<0-31>]
GAMESET <id> SETUP players=<1-6> life=<1-999> [cmdrs=<1|2 per seat, e.g. 1211>]
GAMESET <id> SEAT seat=<0-5> name=<hex of 1-15 printable ASCII bytes>

GAMESET,OK,id=<id>,value=<applied>          (SETUP: players, SEAT: seat)
GAMESET,ERR,id=<id>,status=<busy|not_ready|no_game|no_seat|missing|protected|conflict|
                             wireless|wrong_game|screen|failed>[,value=<current>]
GAMESET,ERR,id=00000000,status=bad_request
```

`SETUP` answers once the Dial has applied the new game, which can take a few
seconds. Snapshots from firmware with setup carry `start_life`, `wireless` and
each player's `commanders`.

`<id>` is 8 hex digits chosen by the caller and echoed back. `index` is
required for custom counters (type 19). One write is handled at a time.

## Development

```bash
npm test
```

Tests run in Node with a simulated Dial. Set `SOULDIAL_GAMESTATE_HOST` to a
firmware host build to also check real firmware output.

## License

[MIT](LICENSE)
