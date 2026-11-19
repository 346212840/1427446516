# Calls

Voice and text calls between accounts, and a guest who opens an invite link. There is no camera.

The switch is `calls`. It starts off. Turn it on in Settings, Server features, after the key is set.

The key stays on the Worker. From `worker/`:

```
npx wrangler secret put GEMINI_API_KEY --name viktorych-accounts
```

Use a free Gemini API key from Google AI Studio with billing off. The browser receives a short-lived token and opens Gemini itself. Call audio is not sent through the Worker.

On the free plan, Google may use call audio to improve its products. The call screen says so in More.

Catalan (`ca`) and Swedish (`sv`) are in the model's language list, with Spanish, English, and Russian pinned first.

A call starts from the Call button on an account profile when that account allows it. Who can call (everyone, people they follow or mutuals, or nobody), a quiet-hours schedule, guest links, and blocks are checked on the server. A block either way refuses the call.

The call screen is mute, speaker, hang up, and talk or type. Everything else is under More. Language, voice match, volumes, subtitles, headset routing, and a slow network are automatic.

Each person can send live voice, text, or a tap-to-talk note, and can hear voice, text, or both. A sender can keep their original voice off the call. The listener's original-voice level ducks while a translation plays.

Translated speech uses a Gemini prebuilt voice chosen from the speaker's pitch. There is no voice cloning. A manual voice in More overrides the match.

People sharing one microphone are labeled Speaker A, B, and C from an on-device voice sketch that runs beside the audio. Each keeps their own language and matched voice. If two of them talk at once, that mix is not sent as one translation. Gemini Live Translate cannot separate overlapping voices. The next person is a new turn. A few milliseconds already handed to the model cannot be pulled back. Names can be renamed on this device.

Guests use the same call tools. Their choices stay in the browser. They do not need an account. One tap joins. If the host turns guest links off, the link stops working.

A missed call can be called back in one tap. A guest keeps a return link. Repeat plays the last translated line. Hold on, Repeat, and Call back are short phrases. A word list in More is sent with the translation setup.

The microphone worklet sends 100 ms of 16 kHz speech, and skips silence. Translated audio is 24 kHz and starts on the first chunk. The Gemini socket is opened while the phone is still ringing. A long call resumes the session before the time limit. If the free-tier minute is tight, the call continues as text.

Bluetooth and headphones take the sound without rebuilding the call. The lock screen can mute or end the call. The screen stays awake during the call.
