# Start local speech on this Windows PC for Audio Studio.
# Qwen3-TTS is the default for English, Spanish and Russian.
# OmniVoice is installed for Swedish and Catalan. Only one model stays on the GPU.
# Fish-Speech 1.5 is optional and is not used automatically.
# Weights and the token stay in %LOCALAPPDATA%\ViktorychLocalVoice.
# See docs/local-voice.md. Personal use for OmniVoice weights.

param(
  [string]$Engines = "qwen,omnivoice"
)

$ErrorActionPreference = "Stop"
$HomeDir = Join-Path $env:LOCALAPPDATA "ViktorychLocalVoice"
$TokenFile = Join-Path $HomeDir "token.txt"
$Wanted = $Engines.ToLower().Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$Port = 8080
$Upstream = 18080

New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

if (-not (Test-Path $TokenFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ([Convert]::ToBase64String($bytes)).TrimEnd("=").Replace("+", "A").Replace("/", "B")
  Set-Content -Path $TokenFile -Value $token -NoNewline
  Write-Host "Wrote a new local token to $TokenFile"
} else {
  $token = (Get-Content -Raw $TokenFile).Trim()
}
if (-not $token) { throw "The local token file is empty." }

$venv = Join-Path $HomeDir "venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  python -m venv $venv
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install --extra-index-url https://download.pytorch.org/whl/cu124 torch torchaudio
& $py -m pip install -U "huggingface_hub[cli]" qwen-tts omnivoice
& $py -m pip install --extra-index-url https://download.pytorch.org/whl/cu124 torch torchaudio

$QwenDir = Join-Path $HomeDir "checkpoints\qwen3-tts-0.6b-base"
$OmniDir = Join-Path $HomeDir "checkpoints\omnivoice"
if ($Wanted -contains "qwen" -and -not (Test-Path (Join-Path $QwenDir "config.json"))) {
  & $py -m huggingface_hub.cli download Qwen/Qwen3-TTS-12Hz-0.6B-Base --local-dir $QwenDir
}
if ($Wanted -contains "omnivoice" -and -not (Test-Path (Join-Path $OmniDir "config.json"))) {
  & $py -m huggingface_hub.cli download k2-fsa/OmniVoice --local-dir $OmniDir
}

$env:LOCAL_VOICE_TOKEN = $token
$env:LOCAL_VOICE_BIND = "127.0.0.1"
$env:LOCAL_VOICE_PORT = "$Port"
$env:LOCAL_VOICE_UPSTREAM = "http://127.0.0.1:$Upstream"
$env:LOCAL_VOICE_QWEN_DIR = $QwenDir
$env:LOCAL_VOICE_OMNI_DIR = $OmniDir
$env:LOCAL_VOICE_SERVER_PORT = "$Upstream"

if ($Wanted -contains "fish") {
  $Repo = Join-Path $HomeDir "fish-speech"
  $Weights = Join-Path $HomeDir "checkpoints\openaudio-s1-mini"
  $FishPort = 18082
  if (-not (Test-Path (Join-Path $Repo ".git"))) {
    git clone --depth 1 --branch v1.5.1 https://github.com/fishaudio/fish-speech.git $Repo
  }
  $fishVenv = Join-Path $HomeDir "venv-fish"
  if (-not (Test-Path (Join-Path $fishVenv "Scripts\python.exe"))) {
    python -m venv $fishVenv
  }
  $fishPy = Join-Path $fishVenv "Scripts\python.exe"
  & $fishPy -m pip install --upgrade pip
  & $fishPy -m pip install --extra-index-url https://download.pytorch.org/whl/cu124 torch torchaudio
  & $fishPy -m pip install -e "$Repo"
  if (-not (Test-Path (Join-Path $Weights "codec.pth"))) {
    & $fishPy -m huggingface_hub.cli download fishaudio/openaudio-s1-mini --local-dir $Weights
  }
  $fish = Start-Process -PassThru -FilePath $fishPy -WorkingDirectory $Repo -ArgumentList @(
    "tools/api_server.py",
    "--listen", "127.0.0.1:$FishPort",
    "--half",
    "--llama-checkpoint-path", $Weights,
    "--decoder-checkpoint-path", (Join-Path $Weights "codec.pth"),
    "--decoder-config-name", "modded_dac_vq",
    "--api-key", $token
  )
  $env:LOCAL_VOICE_FISH_UPSTREAM = "http://127.0.0.1:$FishPort"
  Write-Host "Fish-Speech 1.5 pid $($fish.Id) on 127.0.0.1:$FishPort (half precision, compile off). Auto does not select it."
}

$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$server = Start-Process -PassThru -FilePath $py -WorkingDirectory $RepoRoot -ArgumentList @(
  (Join-Path $RepoRoot "scripts\local_voice_server.py")
)
Write-Host "Local voice server pid $($server.Id) on 127.0.0.1:$Upstream (float16, one engine at a time)"

$proxy = Join-Path $PSScriptRoot "..\local_voice_proxy.py"
& $py $proxy
