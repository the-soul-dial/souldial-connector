// souldial-connector: link a USB Soul Dial with a web app over Web Serial.
// The Convoke adapter is a separate entry point: "souldial-connector/convoke".
export {
  SOULDIAL_USB_FILTERS,
  COUNTER_SOURCE_NONE,
  COUNTER_TYPES,
  LinkError,
  SoulDialLink,
  crc32,
  dialName,
  gamesetCommand,
  publicSnapshot,
  quietSignals,
  webSerialTransport,
} from "./link.js";
export {
  TableSync,
  counterKey,
  customKey,
  dialFields,
  lifeKey,
  parseKey,
} from "./table_sync.js";
