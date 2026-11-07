# Tapula

Self-hosted, swipeable micro-lessons.

- **Accounts:** one admin creates editor accounts. New editors pick their own password on first sign-in, everyone can change their password, and the admin can reset, disable or delete accounts.
- **Editor:** build lessons from cards. Each card can hold headings, text, images (optionally full-bleed), video, **speech** (type a script, pick a voice, and Tapula generates the narration), quizzes or polls (feedback shows in a pop-up sheet), and button links. Drag to reorder; changes autosave.
- **Player:** learners open a link (`/l/<id>`) and swipe through the cards on any device. On tablets and desktops the lesson shows inside a phone mockup. Returning viewers pick up where they left off.
- **Stats:** for each lesson you see viewers, visits, completions, average progress, a per-card "how far people got" chart, new viewers per day, quiz answer breakdowns, and how much of each recording people listened to. Tracking is anonymous: each browser gets a random ID.
- **Export:** download any lesson as a single standalone HTML file, with media embedded.

No dependencies. It's one Node.js file, uses the SQLite built into Node (22.13+), and stores uploads on disk.

## Quick start (local)

```bash
ADMIN_PASSWORD=secret npm start
# open http://localhost:3000 and sign in as "admin" / "secret"
```

Data lives in `./data` (`tapula.db` plus `uploads/`).

## Docker

```bash
docker build -t tapula .
docker run -d --name tapula -p 3000:3000 \
  -e ADMIN_PASSWORD='something-long' \
  -e PUBLIC_URL='https://learn.example.com' \
  -v /path/to/data:/data \
  tapula
```

Or use `docker-compose.yml`.

### Unraid

1. Build the image on the server (or push it to a registry): `docker build -t tapula:latest https://github.com/thepillock/tapula.git#main`
2. **Docker → Add Container**:
   - Repository: `tapula:latest`
   - Port: container `3000` → host e.g. `3000`
   - Path: container `/data` → host `/mnt/user/appdata/tapula`
   - Variables: `ADMIN_PASSWORD`, `PUBLIC_URL` (and optionally `MAX_UPLOAD_MB`, `PUID`, `PGID`)
3. In **Nginx Proxy Manager**, add a proxy host (e.g. `learn.yourdomain`) pointing to `unraid-ip:3000`. Turn on SSL, and raise the upload limit for video by adding `client_max_body_size 200m;` under *Advanced*.

### Live and test builds

The repo has two long-lived branches:

| Branch | Image tag | Container | Use |
|---|---|---|---|
| `main` | `tapula:latest` | `tapula` | Live — what learners use |
| `test` | `tapula:test` | `tapula-test` | Try new versions before they go live |

Build each image from its branch (the `#branch` suffix picks the branch):

```bash
docker build -t tapula:latest https://github.com/thepillock/tapula.git#main
docker build -t tapula:test   https://github.com/thepillock/tapula.git#test
```

Then **Edit → Apply** on the matching container to pick up the new image.

Set up `tapula-test` like the live container, with these differences:

- Repository: `tapula:test` (and set the live container's to `tapula:latest`)
- Host port: a different one, e.g. `3001`
- Data path: its own folder, e.g. `/mnt/user/appdata/tapula-test`, so tests never touch live lessons or stats
- `ADMIN_PASSWORD`: its own (the test instance creates its own admin on first run)
- `PUBLIC_URL`: the test address, if you give it one in Nginx Proxy Manager
- `TTS_URL` can point at the same Kokoro container

To promote a tested version: merge `test` into `main`, rebuild `tapula:latest`, and Apply on `tapula`.

## Text-to-speech (Kokoro)

Speech blocks use an OpenAI-compatible text-to-speech server that also lists its voices, such as [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI): it's free, runs on a CPU, and has natural voices in UK and US English plus several other languages.

**On Unraid:** go to **Docker → Add Container**:
- Name: `kokoro`
- Repository: `ghcr.io/remsky/kokoro-fastapi-cpu:latest`
- Port: container `8880` → host `8880`

Then add this variable to the Tapula container: `TTS_URL` = `http://<unraid-ip>:8880/v1`

The first start downloads the model, which takes a minute. Kokoro doesn't need to be reachable from the internet. Only Tapula talks to it, and the generated audio is stored with the lesson, so learners never touch Kokoro.

The audio is made once, when you click **Generate audio**. If you change the script, voice or speed afterwards, the editor flags that the audio is out of date. You can also upload your own recording (MP3, M4A, WAV or OGG) instead.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | *(first run only)* | Creates the admin account when no accounts exist yet. It's ignored after that, so change your password in the app and you can remove the variable. |
| `ADMIN_USERNAME` | `admin` | Username for that first admin account. |
| `PUBLIC_URL` | derived from request | Base URL used in share links and link previews (e.g. `https://learn.example.com`). |
| `PORT` | `3000` | Listen port. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, uploads and session key. |
| `MAX_UPLOAD_MB` | `100` | Max size per uploaded file. |
| `PUID` / `PGID` | `99` / `100` | (Docker only) User/group the server runs as; the data folder is chowned to it on start. Unraid's defaults are 99/100. |
| `TTS_URL` | *(off)* | OpenAI-compatible text-to-speech base URL, e.g. `http://192.168.1.10:8880/v1` for Kokoro. |
| `TTS_MODEL` / `TTS_API_KEY` | `kokoro` / none | Model name and optional API key for the speech server. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` headers from your reverse proxy. Set to `false` if it's exposed directly. |

## Accounts

- **Admin** (one account, created on first run): everything below, plus **Users**, where you add editors, reset their passwords, and disable or delete them.
- **Editors** can create, edit, publish and delete any lesson, and see all stats.
- New editors and reset accounts get a temporary password and must choose their own when they next sign in.
- Changing your password signs out your other devices.

**Forgotten the admin password?** Reset it from the server:

```bash
docker exec -u 99:100 tapula node server.js reset-password admin 'new-password-here'
```

## How it works

| Path | Who | What |
|---|---|---|
| `/admin` | you | Library, editor and stats (password protected) |
| `/l/<id>` | anyone | Swipe player for a **published** lesson (drafts return 404; add `?preview` while signed in to preview without tracking) |
| `/media/<id>` | anyone | Uploaded images and video (supports range requests for seeking) |
| `/api/track` | player | Anonymous view, progress and quiz events (rate-limited) |
| `/healthz` | monitoring | Returns `ok` |

Backups: copy the data directory. `tapula.db` uses WAL mode, so either stop the container first or use `sqlite3 tapula.db ".backup out.db"`.

## Notes and limits

- Video: MP4 (H.264/AAC) plays everywhere. WebM won't play on older iPhones, and MOV only plays reliably in Safari.
- Stats count browsers, not people. Private windows and cleared storage show up as new viewers.
- Uploaded files that no lesson uses are cleaned up a day after upload, when the server starts or when a lesson is deleted.
