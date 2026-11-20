# Calls

Voice and text calls between accounts, and a guest who opens an invite link. There is no camera.

The switch is `calls`. It starts off. Turn it on in Settings, Server features, after the key is set.

Whose Gemini key a call uses is decided on the server from the call itself, never from anything the browser says.

- The owner key (`GEMINI_API_KEY`, a Worker secret) is used only when the owner is a verified part of the call: the owner placed it, a guest used the owner's call-me link or invite, the owner answered a call, or it is the owner's own test. Until the owner answers, nothing is minted.
- Every other call uses a free Gemini key from the person who needs it. They get a short prompt with a link to https://aistudio.google.com/apikey and a paste field. A signed-in person can save it. It is stored encrypted with `KEYS_ENC_KEY`, slot `call-key:<id>`, and only a mask is ever shown back. A guest's pasted key stays in their browser and rides only the token request. If the host has a saved key, it covers a guest.
- A short-lived token is minted from that person's key, so it is never seen by the other side. If nobody has a key the call screen says so, and text-only is not blocked.

Use a free Gemini API key from Google AI Studio with billing off. The browser receives a short-lived token and opens Gemini itself, unless Google cannot be reached (below).

Call-me links: each account can have one permanent link with an optional custom slug (3 to 30 letters, numbers, single dashes), or an invite that expires in 1 hour or 24 hours. A link can be switched off, replaced, or deleted at any time. It follows the same checks as a call from a profile: who may call, quiet hours, guests, blocks. The link is rate limited by address and by slug.

Reaching Gemini when it is blocked: the page tries Google directly for 3.5 seconds, then goes through the Worker (`GET /v1/calls/live`, a WebSocket pass-through), and remembers the route that worked. Voices go over WebRTC with STUN, then TURN. Optional Worker secrets `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` turn on Cloudflare Realtime TURN (free allowance). A public TLS 443 relay is the last resort and can be turned off with `CALLS_PUBLIC_TURN=off`. Limits: the Worker route carries call audio through the Worker and uses its request budget.

On the free plan, Google may use call audio to improve its products. The call screen says so in More.

Catalan (`ca`) and Swedish (`sv`) are in the model's language list, with Spanish, English, and Russian pinned first.

A call starts from the Call button on an account profile when that account allows it. Who can call (everyone, people they follow or mutuals, or nobody), a quiet-hours schedule, guest links, and blocks are checked on the server. A block either way refuses the call.

The call screen is mute, speaker, hang up, and talk or type. Everything else is under More. Language, voice match, volumes, subtitles, headset routing, and a slow network are automatic.

Each person can send live voice, text, or a tap-to-talk note, and can hear voice, text, or both. A sender can keep their original voice off the call. The listener's original-voice level ducks while a translation plays.

Translated speech uses a Gemini prebuilt voice chosen from the speaker's pitch. There is no voice cloning. A manual voice in More overrides the match.

People sharing one microphone are labeled Speaker A, B, and C from an on-device voice sketch that runs beside the audio. Each keeps their own language and matched voice. If two of them talk at once, that mix is not sent as one translation. Gemini Live Translate cannot separate overlapping voices. The next person is a new turn. A few milliseconds already handed to the model cannot be pulled back. Names can be renamed on this device.

Guests use the same call tools on the stand-alone page at `/calls/`, which has no app around it. Their choices stay in the browser. They do not need an account. One tap joins. If the host turns guest links off, the link stops working.

A missed call can be called back in one tap. A guest keeps a return link. Repeat plays the last translated line. Hold on, Repeat, and Call back are short phrases. A word list in More is sent with the translation setup.

The microphone worklet sends 100 ms of 16 kHz speech, and skips silence. Translated audio is 24 kHz and starts on the first chunk. The Gemini socket is opened while the phone is still ringing. A long call resumes the session before the time limit. If the free-tier minute is tight, the call continues as text.

Bluetooth and headphones take the sound without rebuilding the call. The lock screen can mute or end the call. The screen stays awake during the call.

## Phones on weak mobile data (iPhone and Pixel)

- The page creates one audio context on the first tap and reuses it for ringing and calls, because iOS keeps a context made later (after a fetch) suspended. It is resumed again on `statechange`, `pageshow`, focus and visibility, and every 2 s while the page is visible. `navigator.audioSession` is `play-and-record` during a call.
- Without `setSinkId` (iOS Safari) the call keeps the default output; Ear mode then lowers the volume instead of switching to the earpiece.
- Without the Wake Lock API a looping muted 1 s clip keeps the screen on.
- When the network changes (`online`, Network Information `change`) signalling reconnects at once, the host restarts ICE, and the Gemini sockets skip their back-off.
- Every 4 s the remote loss and round trip pick the Opus bitrate (64, 32, 24 or 16 kbit/s): worse quickly, better after three clean samples.
- The translated voice is scheduled with a lead that starts at 60 ms, grows by 80 ms (up to 500 ms) when the audio runs dry in the middle of a phrase, floors at 100/160/240 ms on weaker links, and shrinks by 40 ms after 20 s without a gap.
- Cloudflare Realtime TURN needs the Worker secrets `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`; until they exist the public TLS 443 relay is the fallback.

## Latency timing (calls_latency)

Every translated phrase is timed on the device that hears it (`createTimeline` in `shared/call-audio.js`, hooks in `createPipe`): first and last voiced frame (`speechMs`), first frame sent (`toSent`), first model reply, audio or text (`toByte`), and first translated sound scheduled on the speaker (`toPlay`). `stopToPlay` is measured from the last voiced frame, so it is negative when the streamed answer starts before the speaker stops. The statistics list and the test-call chips show the median and slowest `stopToPlay`, `toByte`, `byteToPlay` and the number of phrases timed; the last 30 phrases are in `ViktorychCalls.debug().timings` and `.partnerTimings` (test calls). The owner switch `calls_latency` only hides the numbers.

## Live stream and turn fallback (calls_live_stream)

The call already opens one Gemini Live Translate session per direction and sends speech as it is heard. With this switch on, a silent 20 ms keep-alive is sent after 45 s of quiet so a phone network does not drop the socket, and if the persistent stream fails the call does not go to text at once: each phrase is held until the speaker pauses, then sent as one Live turn. A failed one-shot turn still goes to text. Audio stays in the browser; only a short-lived token is minted. Off keeps the persistent session only, with no keep-alive, and a failed stream goes to text.

## Streamed playback and word-by-word captions (calls_stream_play)

With this switch on, the first translated chunk is scheduled at the audio clock (no 60 ms lead); later chunks still use the adaptive lead so a weak link does not underrun. Live captions merge each transcription update (a delta or the whole line so far) and render the growing line as words, with the newest word marked. Off keeps the 60 ms first-chunk lead and shows the caption as a plain line. Transcript merging is always on, so a cumulative update cannot repeat the start of the phrase.

## Shorter end of speech (calls_short_eos)

The quiet-voice gate already tracks the room's noise floor. With this switch on, a clear silence (well below that gate) shortens the hang after the last word from 1200 ms toward about 600 ms, and the Live session is told the phrase has ended as soon as the gate closes, instead of waiting another 600 ms. Soft endings near the gate, and the strict/loop gate while a translation is playing, keep the full tail so a whisper is not cut off. Off keeps the 1200 ms hang and the 1800 ms flush.
