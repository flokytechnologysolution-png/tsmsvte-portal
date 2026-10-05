# Taraba State Ministry of Secondary, Vocational and Technical Education — Portal

Official web portal and staff intranet for the ministry. One Node.js process,
one SQLite file, plain HTML/CSS/JS — **no build step and no Docker**.

## Quick start

    npm install        # install dependencies
    npm start          # start the portal on http://localhost:3000

Copy `.env.example` to `.env` and change `JWT_SECRET`, `OWNER_EMAIL` and
`OWNER_PASSWORD` before going live. On first boot the schema, the 16 LGAs, the
FAQ, SMS templates, the knowledge base and the owner account are created
automatically.

On Windows you can also just double-click `run.bat`.

## Production deployment

The portal is one Node.js process, so "deploying" means: install, configure
the environment, put a TLS-terminating proxy in front, and keep it running.

### 1. Install

    git clone <your-repo> tsmsvte-portal
    cd tsmsvte-portal
    npm install --omit=dev

### 2. Configure `.env`

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables HSTS and hides stack traces |
| `PORT` | `3000` | The port Node listens on (the proxy talks to this) |
| `JWT_SECRET` | 32+ random characters | **Required.** The portal refuses to start in production without it |
| `COOKIE_SECURE` | `1` | Only send the sign-in cookie over HTTPS |
| `TRUST_PROXY` | `1` | Tell Express the real client IP comes from the proxy (rate limiting keys off it) |
| `PORTAL_URL` | `https://portal.example.gov.ng` | Used in links and SMS text |
| `OWNER_EMAIL` / `OWNER_PASSWORD` / `OWNER_NAME` | your values | The first owner account |
| `MAIL_DOMAIN` | `tsmsvte.gov.ng` | Internal mail addresses become `firstname.lastname@<domain>` |
| `MAX_UPLOAD_MB` | `5` | Upload ceiling |

Generate a strong secret:

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

Then start it:

    npm run start:prod

`start:prod` sets `NODE_ENV=production` (Windows-safe, no extra dependency) and
refuses to start if `JWT_SECRET` is missing or too short.

### 3. HTTPS with a reverse proxy

Terminate TLS at the proxy and forward to Node. **Nginx** (Linux):

```nginx
server {
    listen 443 ssl http2;
    server_name portal.example.gov.ng;

    ssl_certificate     /etc/letsencrypt/live/portal.example.gov.ng/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.example.gov.ng/privkey.pem;

    client_max_body_size 25M;          # uploads are capped in the app too

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # the chat widget uses a WebSocket
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
    }
}
```

**Caddy** (one line, automatic certificates):

    portal.example.gov.ng {
        reverse_proxy 127.0.0.1:3000
        request_body { max_size 25MB }
    }

Then set `COOKIE_SECURE=1` and `TRUST_PROXY=1` in `.env`.

### 4. Keep it running

**PM2 (Linux, recommended):**

    npm install -g pm2
    pm2 start server.js --name tsmsvte-portal --env production
    pm2 save
    pm2 startup        # run the command it prints, then: pm2 save

Make sure `NODE_ENV=production` and `JWT_SECRET` are in the environment PM2
inherits (a `.env` file in the project folder is enough for the app itself).

**Windows — run as a service:** use [NSSM](https://nssm.cc) (free) or the
"Windows Task Scheduler" trick:

    schtasks /create /tn "TSMSVTE Portal" /tr "node server.js" ^
      /sc onstart /rl HIGHEST /f

Or simply start it with `run.bat` and leave the window open for a small office
installation.

### 5. Backups — do this first

    npm run backup              # write backups/backup-YYYYMMDD-HHMMSS/
    npm run backup -- --list    # see what you have
    npm run backup -- --keep 30 # keep 30 instead of the default 14

`portal.db` is copied with SQLite's `VACUUM INTO`, so the snapshot is
consistent even while the portal is serving requests. The `uploads/` folder is
copied alongside it. The newest 14 are kept; older ones are deleted.

**Scheduling it** (daily at 02:15):

    # Linux / cron
    15 2 * * * cd /srv/tsmsvte-portal && /usr/bin/npm run backup >> backups.log 2>&1

    # Windows / Task Scheduler
    schtasks /create /tn "TSMSVTE Backup" /tr "npm run backup" ^
      /sc daily /st 02:15 /f

Copy the `backups/` folder off the machine as well — a backup on the same disk
does not survive losing that disk.

**Restoring:** stop the portal, then copy the files back and start again.

    # Linux
    sudo systemctl stop tsmsvte-portal        # or: pm2 stop tsmsvte-portal
    cd /srv/tsmsvte-portal
    cp backups/backup-20260101-021500/portal.db data/portal.db
    rm -f data/portal.db-wal data/portal.db-shm
    rm -rf uploads && cp -r backups/backup-20260101-021500/uploads uploads
    sudo systemctl start tsmsvte-portal

    # Windows
    # stop the node process / the scheduled task, then:
    copy /Y backups\backup-20260101-021500\portal.db data\portal.db
    del /Q data\portal.db-wal data\portal.db-shm 2>nul
    rmdir /S /Q uploads & xcopy /E /I /Y backups\backup-20260101-021500\uploads uploads

You can also restore from **Admin → Backup & restore** in the portal itself
while it is running.

## Seeding data

The `schools` table ships **empty** (apart from the 16 LGAs) — real schools are
added from the admin console or in bulk with the seeding tool. The same tool can
also drop in a little **sample** content so the front page is not empty.

### Import your real school list

Put the list in a CSV with this header row:

```csv
name,lga,type,address,phone,email,principal
```

Only `name` and `lga` are required. Optional columns, if present, are also
imported: `category`, `boarding`, `year_established`, `notes`, `status`. A JSON
file (an array of objects with the same keys) works too.

Then run:

    npm run seed -- --schools data/schools.csv

The `lga` value is matched to the 16 official LGAs **case-insensitively and
ignoring spaces and hyphens**, so `Karim-Lamido`, `karim lamido` and the stored
`Karim Lamido` all resolve to the same LGA. Rows with a missing name or an
unknown LGA are skipped and listed at the end — they never abort the import.

The import is **idempotent**: a school with the same name and LGA is updated in
place, anything else is created. Running it twice never duplicates a row.

### Sample content

    npm run seed -- --sample            # add sample news items + circulars
    npm run seed -- --wipe-samples      # remove ONLY the sample rows

> **Sample rows are placeholders.** `data/schools.sample.csv` holds five clearly
> fake example schools (one per LGA) that only demonstrate the CSV format, and
> `--sample` inserts placeholder news and circulars that contain no statistics,
> quotations, dates of real events or names of officials. **Replace all of them
> with the ministry's real, approved content** before the portal goes live.

### All flags

| Flag | What it does |
| --- | --- |
| `--schools <file>` | Import schools from a CSV or JSON file. |
| `--sample` | Insert the sample news items and circulars. |
| `--dry-run` | Print what would happen and write nothing. |
| `--wipe-samples` | Delete the rows tagged as samples (never real data). |
| `--help` | Show the usage message. |

Example — preview a sample import without touching the database:

    npm run seed -- --schools data/schools.sample.csv --sample --dry-run

Every run writes inside a single transaction, so a failure rolls the whole run
back. Rows created by the tool are tagged with `is_sample = 1` (added to
`schools`, `news` and `circulars` by a migration in `db.js`), which is what makes
`--wipe-samples` safe.

## Layout

    server.js          Express app + HTTP/WebSocket server
    db.js              SQLite schema, seed data and helpers
    routes/            API routes (auth, staff, schools, news, faqs, ...)
    lib/               small helpers (csv, zip, ai, sms, mailer, realtime)
    middleware/        auth, csrf, rate limiting, uploads, validation
    public/            the front end (pages + js + css)
    tools/             maintenance scripts (make-icons.js, seed.js)
    uploads/           uploaded photos, news images, circulars, mail
