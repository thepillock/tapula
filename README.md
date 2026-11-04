# Tapula

Self-hosted, swipeable micro-lessons, in the spirit of 7taps.

- **Editor:** build lessons from cards. Each card can hold headings, text, images (optionally full-bleed), video, quizzes or polls, and button links. Drag to reorder; changes autosave.
- **Player:** learners open a link (`/l/<id>`) and swipe through the cards on any device. On tablets and desktops the lesson shows inside a phone mockup. Returning viewers pick up where they left off.
- **Stats:** for each lesson you see viewers, visits, completions, average progress, a per-card "how far people got" chart, new viewers per day, and quiz answer breakdowns. Tracking is anonymous: each browser gets a random ID.
- **Export:** download any lesson as a single standalone HTML file, with media embedded.

No dependencies. It's one Node.js file, uses the SQLite built into Node (22.13+), and stores uploads on disk.

## Quick start (local)

```bash
ADMIN_PASSWORD=secret npm start
# open http://localhost:3000 and sign in
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

1. Build the image on the server (or push it to a registry): `docker build -t tapula https://github.com/thepillock/Tapula.git`
2. **Docker → Add Container**:
   - Repository: `tapula`
   - Port: container `3000` → host e.g. `3000`
   - Path: container `/data` → host `/mnt/user/appdata/tapula`
   - Variables: `ADMIN_PASSWORD`, `PUBLIC_URL` (and optionally `MAX_UPLOAD_MB`)
3. In **Nginx Proxy Manager**, add a proxy host (e.g. `learn.yourdomain`) pointing to `unraid-ip:3000`. Turn on SSL, and raise the upload limit for video by adding `client_max_body_size 200m;` under *Advanced*.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | *(required)* | Password for the editor. Changing it signs out all sessions. |
| `PUBLIC_URL` | derived from request | Base URL used in share links and link previews (e.g. `https://learn.example.com`). |
| `PORT` | `3000` | Listen port. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, uploads and session key. |
| `MAX_UPLOAD_MB` | `100` | Max size per uploaded file. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` headers from your reverse proxy. Set to `false` if it's exposed directly. |

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
