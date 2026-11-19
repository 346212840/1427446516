# Music tab on this computer

The Music tab in Audio Studio (`#/studio/music`) talks only to a [FlowMusic2API](https://github.com/genz27/FlowMusic2API) process on the owner's Windows PC. The project is MIT licensed. It is not useapi.net, and this app does not store a useapi.net token.

The connector signs in to the owner's existing Flow Music account on that PC (the Plus plan that comes with Google AI Pro). Those credentials stay in FlowMusic2API's own data folder. Do not put Google cookies, refresh tokens, or the local API key in this repository, in GitHub, in Cloudflare, or in logs.

## Do songs show on the Flow Music website?

Yes, when the local server is connected to that Flow Music account. FlowMusic2API does not invent a private library. `Generate` calls `StartConversation`, which sends `POST /__api/conversation` to the Flow Music site (`internal/service/flowmusic.go` and `internal/service/generation.go` in genz27/FlowMusic2API). That is the same conversation the website creates, and the connector then reads the clips from that account. The song therefore shows in the Flow Music website library for the signed-in account.

Audio Studio also saves every song it receives in this browser (IndexedDB, `viktorych-studio-songs-v1`), so the list remains if the website is closed.

## Run it

FlowMusic2API binds to `127.0.0.1` when `FLOWMUSIC_HTTP_BIND=127.0.0.1` (that is already its default).

```powershell
$HomeDir = Join-Path $env:LOCALAPPDATA "ViktorychFlowMusic"
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Set-Location $HomeDir
if (-not (Test-Path .git)) { git clone https://github.com/genz27/FlowMusic2API.git . }
# Local API key only. Do not commit it.
$env:FLOWMUSIC_HTTP_BIND = "127.0.0.1"
$env:FLOWMUSIC_HTTP_PORT = "8000"
$env:FLOWMUSIC_DEFAULT_API_KEY = ([guid]::NewGuid().ToString("N"))
$env:FLOWMUSIC_ADMIN_PASSWORD = ([guid]::NewGuid().ToString("N"))
docker compose -f docker-compose.sqlite.yml up -d
```

Open `http://127.0.0.1:8000/manage` on this PC and add the Flow Music account there. Then, on a desktop, open Audio Studio → Music, set port `8000`, and paste that local API key. The key stays in this browser.

A phone does not show the generator. It only says that music on this computer is desktop only.

Lyria 3.5 is the model id `lyria`. Lyria 3 Pro is `lyria-pro`. Lyrics and the instrumental switch are added to the prompt, which is the field this connector sends.
