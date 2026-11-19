/* Plans for lossless and lossy output, including a Telegram voice note. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { TextEncoder, Uint8Array, Uint32Array };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(root, "audio-convert-plan.js"), "utf8"), vm.createContext(sandbox));
const plan = sandbox.AudioConvertPlan;
const probe = { rate: 44100, channels: 2, bits: 16, float: false, duration: 3, hasCover: false, audio: true, codec: "pcm_s16le" };

const flac = plan.argsFor(probe, { format: "flac", flac: 8, depth: "orig" }, "in", "out");
assert.equal(flac.ext, "flac");
assert.equal(flac.lossy, false);
assert.ok(flac.args.includes("flac"));

const mp3 = plan.argsFor(probe, { format: "mp3", mp3: "320" }, "in", "out");
assert.equal(mp3.ext, "mp3");
assert.equal(mp3.lossy, true);
assert.ok(mp3.args.includes("320k"));

const voice = plan.argsFor(probe, { voice: true }, "in", "out");
assert.equal(voice.ext, "ogg");
assert.ok(voice.args.includes("libopus"));
assert.ok(voice.args.includes("48000"));
assert.ok(voice.args.includes("1"));

const zip = plan.zipStore([{ name: "a.flac", bytes: new Uint8Array([1, 2, 3, 4]) }]);
assert.equal(String.fromCharCode(zip[0], zip[1]), "PK");
console.log("audio convert plan ok");
