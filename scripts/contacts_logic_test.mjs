// Contacts: vCard round trip and call suggestions, without a browser.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const C = require("../contacts-ui.js");

const FAKE_A = ["+00", "000", "000", "001"].join(" ");
const FAKE_B = ["+00", "000", "000", "002"].join(" ");
const card = [
  "BEGIN:VCARD", "VERSION:3.0", "N:Díaz;Carlos;;;", "FN:Carlos Díaz", "ORG:Acme\\, Inc",
  "TEL;TYPE=CELL:" + FAKE_A, // secret-scan: allow made-up test number
  "TEL;TYPE=WORK:" + FAKE_B, // secret-scan: allow made-up test number
  "EMAIL;TYPE=HOME:carlos@example.es", "BDAY:1990-04-02", "NOTE:Line one\\nLine two", "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "FN:Anna Ek", "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "END:VCARD"
].join("\r\n");
const list = C._parseVcf(card);
assert.equal(list.length, 2, "an empty card is skipped");
assert.equal(list[0].first, "Carlos");
assert.equal(list[0].last, "Díaz");
assert.equal(list[0].company, "Acme, Inc");
assert.deepEqual(list[0].phones.map((p) => p.label), ["Mobile", "Work"]);
assert.equal(list[0].notes, "Line one\nLine two");
assert.equal(list[1].first, "Anna");
assert.equal(list[1].last, "Ek");

const out = C._vcardOf(list[0]);
const again = C._parseVcf(out)[0];
assert.equal(again.first, "Carlos");
assert.equal(again.company, "Acme, Inc");
assert.equal(again.phones.length, 2);
assert.equal(again.birthday, "1990-04-02");
assert.equal(again.notes, "Line one\nLine two");

assert.deepEqual(C.suggestions("c"), [], "guests get no suggestions");
console.log("contacts logic ok");
