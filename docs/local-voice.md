# Local voice on a Windows PC

Audio Studio → Type to Voice → Local voice talks only to `http://127.0.0.1:8080` on the owner's computer. Phones do not show it. The token, the weights, and the reference clips stay on that PC. Nothing is uploaded to ViktorychApp.

The page reads the text, guesses the language, and lets the owner override it. Auto then picks an engine that lists that language. Forcing an engine that does not list the language is ignored, and the note says Auto picked another.

| Language | Auto engine |
| --- | --- |
| English, Spanish, Russian | Qwen3-TTS 0.6B Base |
| Swedish, Catalan | OmniVoice |

Fish-Speech 1.5 can be installed as well. Auto does not select it: its card lists English, Spanish and Russian, and it does not list Swedish or Catalan. Qwen3-TTS already covers those three.

## Support matrix

Checked against the model cards in November 2026. A blank cell is not in that card. "Fits 6 GB" is yes only when the published size or this project's half-precision path fits an RTX 2060 6 GB. Two 0.6B models are not loaded together.

| Engine | en | es | ru | sv | ca | License | 6 GB RTX 2060 | Role |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3-TTS 0.6B Base | yes | yes | yes | | | Apache-2.0 | yes, float16, one model | Auto for en, es, ru |
| OmniVoice | yes | yes | yes | yes | yes | Code Apache-2.0. Weights CC-BY-NC | yes, float16, one model | Auto for sv, ca. Personal use |
| Fish-Speech 1.5 | yes | yes | yes | | | CC BY-NC-SA 4.0 | yes, `--half` | Optional. Not auto |
| Fun-CosyVoice 3 0.5B | yes | yes | yes | | | Apache-2.0 | yes (0.5B) | Not used. No Swedish or Catalan |
| VoxCPM2 | yes | yes | yes | yes | | Apache-2.0 | no. Card says about 8 GB | Not used |
| Chatterbox Multilingual v3 | yes | yes | yes | yes | | MIT, retired August 2026 | yes (0.5B) | Not used. No Catalan, and the project is an archive |
| XTTS-v2 | yes | yes | yes | | | Coqui Public Model License, non-commercial | not selected | Not used. No Swedish or Catalan |

Qwen3-TTS languages, from the [0.6B Base card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base) and the [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) table: Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian. Swedish and Catalan are not in that list. The clone checkpoint is `Qwen/Qwen3-TTS-12Hz-0.6B-Base`. The 1.7B Base clone is not the target: a published measurement puts its peak near 7.5 GiB. The official loader sample uses bfloat16. This card is Turing and has no bfloat16, so the helper loads float16 with SDPA. Flash attention and compile stay off. A community measurement put the 0.6B Base near 5.6 GiB in bfloat16, which is tight, so other GPU programs should be closed. The 1.7B VoiceDesign and Drama 3 models are not installed.

OmniVoice languages, from the [k2-fsa/OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) card and [docs/languages.md](https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md): English (206061.1 h), Spanish (27559.74 h), Russian (20338.5 h), Swedish (2453.14 h), Catalan (3358.6 h), among 600 others. The card's license section says the code is Apache-2.0 and the pretrained weights are CC-BY-NC. That is personal use, not a hosted service. The official load example is `dtype=torch.float16` on a Qwen3-0.6B backbone. The card does not publish a VRAM number. The server unloads Qwen3-TTS before loading OmniVoice so the 6 GB card holds one of them.

Fish-Speech 1.5 languages, from the [fishaudio/fish-speech-1.5](https://huggingface.co/fishaudio/fish-speech-1.5) card: English, Chinese, Japanese, German, French, Spanish, Korean, Arabic, Russian, Dutch, Italian, Polish, Portuguese. No Swedish. No Catalan. Weights are CC BY-NC-SA 4.0. The helper still pins tag `v1.5.1` and `fishaudio/openaudio-s1-mini` with `--half` and without `--compile`. [Fish Audio's install guide](https://speech.fish.audio/install/) asks for at least 24 GB for S2-Pro and 48 GB for Drama 3. Those are not installed.

Fun-CosyVoice 3 languages, from [FunAudioLLM/Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512): Chinese, English, French, Spanish, Japanese, Korean, Italian, Russian, German. No Swedish. No Catalan. Apache-2.0. It fits, and it does not fill the gap, so it is not installed.

VoxCPM2 languages, from [openbmb/VoxCPM2](https://huggingface.co/openbmb/VoxCPM2): 30 languages including English, Spanish, Russian and Swedish. Catalan is not in that list. The card says about 8 GB. It does not fit this GPU.

Chatterbox Multilingual v3, from the [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox/) archive: the repository says that as of August 2026 Chatterbox is retired research and is no longer maintained. The published language list includes Swedish and does not include Catalan. MIT. It is not installed.

XTTS-v2 languages, from [coqui/XTTS-v2](https://huggingface.co/coqui/XTTS-v2): English, Spanish, French, German, Italian, Portuguese, Polish, Turkish, Russian, Dutch, Czech, Arabic, Chinese, Japanese, Hungarian, Korean, Hindi. No Swedish. No Catalan. The weights use the Coqui Public Model License (non-commercial). It is not installed.

## Install and run

On Windows 11, in PowerShell, from a checkout of this repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-voice\start-local-voice.ps1
```

That installs Qwen3-TTS and OmniVoice. Add Fish-Speech 1.5 only when you want the optional engine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-voice\start-local-voice.ps1 -Engines "qwen,omnivoice,fish"
```

The script:

1. Creates `%LOCALAPPDATA%\ViktorychLocalVoice`.
2. Writes a random token to `token.txt` the first time. It does not print the token.
3. Installs PyTorch for CUDA 12.4, then `qwen-tts` and `omnivoice`, and downloads `Qwen/Qwen3-TTS-12Hz-0.6B-Base` and `k2-fsa/OmniVoice` into `checkpoints`.
4. Starts `scripts/local_voice_server.py` on `127.0.0.1:18080`. The first request for a language loads that engine in float16 and unloads the other.
5. Starts `scripts/local_voice_proxy.py` on `127.0.0.1:8080` with the token, CORS, and Private Network Access.

If Fish-Speech is included, it is a second virtual environment and `tools/api_server.py` on `127.0.0.1:18082`. The router forwards to it only when the Engine menu is set to Fish-Speech 1.5 and the language is English, Spanish or Russian.

Copy the token from `token.txt` into the Local voice token field on a desktop. The page keeps it in this browser.

Health check, from the same PC:

```powershell
$token = Get-Content -Raw "$env:LOCALAPPDATA\ViktorychLocalVoice\token.txt"
Invoke-RestMethod http://127.0.0.1:8080/v1/health -Headers @{ Authorization = "Bearer $token" }
```

`status: ok` means the router is up. `engines.qwen` and `engines.omnivoice` are true after the weights are on disk.

## In the app

Language starts on Auto. The guess uses the letters and a few words (Cyrillic for Russian, å ä ö for Swedish, Catalan and Spanish markers, otherwise English). The menu can force English, Spanish, Swedish, Catalan or Russian. The line under the menu names the engine that will run.

Reference clips stay in this browser. Generate sends the clip and the text to loopback and asks for WAV. The same voice, language, engine and text replay from this browser and do not call the GPU again.

`scripts/local-voice/docker-compose.yml` is only the optional Fish-Speech 1.5 container. It is not the Qwen3-TTS or OmniVoice path, and it does not download weights.
