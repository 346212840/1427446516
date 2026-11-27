---
title: Viktorych TikTok Live
emoji: 🔴
colorFrom: gray
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

Always-on TikTok LIVE recorder for 1427446516.

This Space only holds `README.md` and `Dockerfile`. The Dockerfile clones
1427446516 and runs `docker/tiktok-live/start.sh`, so a restart picks up
the newest code. Setup, secrets and limits are in `docs/free-cloud-backup.md`
in the 1427446516 repository.

`/health` returns 200 while the watcher is cycling. `/status` shows counts
only and needs the `TIKTOK_STATUS_TOKEN` secret as a bearer token.
