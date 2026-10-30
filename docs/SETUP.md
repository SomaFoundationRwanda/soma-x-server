# Setting up soma-x-server on the VPS

This guide takes a fresh Ubuntu 24.04 VPS to a running soma-x-server that SomaBox devices
download content from and push their data to. For development on your own machine, see the
README's quick start instead.

The examples use `cloud.somaglobaltalent.org`, the address the boxes already use as
`CLOUD_URL`. Replace it if yours differs.

**What runs where:**

```
SomaBox (offline most of the time)        VPS
  soma-x-backend ── HTTPS ──────────▶ nginx :443 ──▶ soma-x-server :2999 ──▶ PostgreSQL
    downloads content                                 │
    pushes its sync outbox                            └── content/ (files on disk)
```

## 1. Install the system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx postgresql ffmpeg certbot python3-certbot-nginx

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

node -v        # v22.x
ffprobe -version | head -1
```

`ffmpeg` provides `ffprobe`, which reads audio/video durations. Without it, everything else
still works and durations are left empty.

## 2. Create the database

```bash
sudo -u postgres createuser --pwprompt somax      # choose a strong password
sudo -u postgres createdb --owner somax somax
```

PostgreSQL only listens on localhost by default. Keep it that way.

## 3. Get the code

Use a normal user (not root), for example `somax`:

```bash
sudo adduser --disabled-password --gecos "" somax
sudo -iu somax
git clone https://github.com/SomaFoundationRwanda/soma-x-server.git
cd soma-x-server
npm ci
```

## 4. Configure

```bash
cp .env.example .env
nano .env
```

| Setting | Value |
|---|---|
| `DATABASE_URL` | `postgres://somax:<password>@localhost:5432/somax` |
| `ADMIN_TOKEN` | output of `openssl rand -hex 32`. Keep it secret: it controls uploads, devices and reports |
| `PORT` | `2999` (nginx forwards to it) |
| `CONTENT_ROOT` | `/home/somax/soma-x-server/content`, or a bigger disk such as `/srv/somax/content` |
| `DATA_DIR` | `/home/somax/soma-x-server/data`: upload temp files. Put it on the same disk as `CONTENT_ROOT` and never inside it |
| `CORS_ORIGINS` | `*`, or the staff portal's address once it has one |
| `MAX_UPLOAD_MB` | `2048` (match nginx below) |

## 5. Build and start

```bash
npm run build
pm2 start ecosystem.config.cjs     # database migrations run automatically on start
pm2 save
pm2 startup                         # prints one sudo command: run it so the server starts on boot
```

Check it:

```bash
curl -s localhost:2999/api/v1/health      # {"ok":true,"db":"up"}
pm2 logs soma-x-server --lines 30         # "startup scan done", "[watch] watching ..."
```

Run only **one** instance (the ecosystem file does this), because the folder watcher must not run twice.

## 6. nginx and HTTPS

Point the domain's DNS `A` record at the VPS first. Then create
`/etc/nginx/sites-available/soma-x-server`:

```nginx
server {
    server_name cloud.somaglobaltalent.org;

    # Content uploads and box sync batches can be large.
    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:2999;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/soma-x-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cloud.somaglobaltalent.org      # HTTPS, auto-renewing
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Port 2999 stays closed to the internet. Only nginx reaches it.

`curl -s https://cloud.somaglobaltalent.org/api/v1/health` should now answer from anywhere.

## 7. Add content

Content lives in two folders under `CONTENT_ROOT`:

| Folder | What it is | Boxes see it as |
|---|---|---|
| `curriculum/rwanda/` | Rwandan education files, in any folder structure (e.g. `primary-4/maths/unit-1.pdf`) | the Sync page's content list |
| `books/` | Library books; sub-folder names become categories (`books/science/cell.epub`) | the Library's cloud books |

There are two ways to add files, and neither needs a command afterwards:

- **SFTP/scp** straight into those folders. The server notices new, changed and deleted files
  within a few seconds and indexes them (hash, size, pages, duration, EPUB title/author).
- **Upload API:**
  ```bash
  curl -H "Authorization: Bearer $ADMIN_TOKEN" \
    -F collection=curriculum -F folder=primary-4/maths -F file=@unit-3.pdf \
    https://cloud.somaglobaltalent.org/api/v1/admin/content
  ```
  Use `collection=library` for books, adding `-F categories=science,biology` and `-F title=...` if wanted.

Check what is indexed: `curl -s https://cloud.somaglobaltalent.org/metadata` (curriculum) and
`/library-metadata?formats=epub,pdf` (books). Boxes running older software list only EPUB books, because they store every book as `.epub`; update the box's `soma-x-backend` to see PDFs.

## 8. Register each box

Every box gets its own key:

```bash
cd ~/soma-x-server
npm run device:create -- --name "GS Kigali box 1" --location "Kigali, Gasabo"
```

The key (`sbx_...`) is printed **once**. Put it on the box as `SYNC_TOKEN`, following the box
setup guide (somabox-lms `docs/ops-box-setup.md`). If a key is lost or leaked:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://cloud.somaglobaltalent.org/api/v1/admin/devices/<device-id>/rotate-key
```

To cut a box off, PATCH the device with `{"status":"revoked"}`.

## 9. Give the staff portal its own token

The staff portal (sfr-management) runs on the same VPS and talks to this server over localhost.
Give it a scoped token, never `ADMIN_TOKEN`:

```bash
npm run token:create -- --name "staff portal" --scopes read,devices:write,content:write
```

Put the printed `sxa_...` token in the portal's `.env` as `SOMAX_API_TOKEN`, with
`SOMAX_API_URL=http://127.0.0.1:2999`. Everything the portal changes is recorded with the staff
member's email (`GET /api/v1/admin/audit`).

## 10. Check that boxes are arriving

```bash
H="Authorization: Bearer $ADMIN_TOKEN"; U=https://cloud.somaglobaltalent.org/api/v1/admin
curl -s -H "$H" $U/stats/devices      # each box: school, last seen, last sync run, learners, courses
curl -s -H "$H" $U/stats/schools
curl -s -H "$H" "$U/stats/usage?groupBy=district"
```

A box shows up after its first successful sync. Boxes are offline most of the time, so an old
`last_seen_at` is normal. They catch up as soon as they are connected.

## 11. Backups

Back up the database (everything boxes have pushed is stored only here) and the content folder:

```bash
sudo mkdir -p /var/backups/somax && sudo chown somax /var/backups/somax
crontab -e
```

```cron
# 03:00 daily: database dump, keep 30 days
0 3 * * * pg_dump -Fc "postgres://somax:<password>@localhost/somax" > /var/backups/somax/somax-$(date +\%F).dump && find /var/backups/somax -name '*.dump' -mtime +30 -delete
```

Copy `/var/backups/somax` and `CONTENT_ROOT` off the VPS regularly (your provider's snapshots,
or `rsync` to another machine). To restore: `pg_restore --clean -d somax <file>.dump`.

## Updating

```bash
cd ~/soma-x-server
git pull
npm ci
npm run build
pm2 restart soma-x-server        # new migrations apply on start
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `{"ok":false,"db":"down"}` | `DATABASE_URL` and the password; `sudo systemctl status postgresql` |
| A copied file doesn't appear | Hidden names, and names ending `.part`, `.tmp` or `~`, are ignored. See `pm2 logs`, or run `curl -X POST -H "$H" $U/reindex` |
| Upload fails with 413 | nginx `client_max_body_size` and `MAX_UPLOAD_MB` |
| A box gets 401 | Wrong or rotated key in the box's `SYNC_TOKEN`; 403 means the device is revoked |
| No durations on videos | `ffprobe` missing (`sudo apt install ffmpeg`), or set `FFPROBE_PATH` |
| Box data seems incomplete | The box decides what it sends (Sync page on the box; default: anonymous IDs, no names, emails or written answers) |
