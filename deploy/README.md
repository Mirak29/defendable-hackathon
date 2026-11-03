# Deploying Defendable on one machine

One container serves everything: the API, the voice interview (WebSocket), the
web app, the voice of Oracle and the sandboxes. The database is a SQLite file in
a Docker volume. Sized for a machine with **4 fast cores or more and 8 GB of
memory** (the voice wants the cores: run
`docker compose exec app deno task tts:bench` and read the last line).

## 1. The machine

Any Linux x86-64 machine with Docker and the Compose plugin (`docker compose`).
On a Brev VM:

```bash
docker --version || curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and in again
```

Disk: 40 GB is comfortable (the image is about 1.2 GB, with the voice model in
it).

## 2. The image, the files and the secrets

The image is built and published by GitHub, not on the machine: the workflow
`.github/workflows/publish.yml` runs at every push to `main` (or by hand, in
the Actions tab) and publishes `ghcr.io/mirak29/defendable:latest`. It first calls
the reusable `.github/workflows/checks.yml` workflow, which installs the locked
dependencies and runs `deno task all` (type-check, lint and tests). The image job
depends on these checks succeeding; a failed check blocks the build and
publication. Checks also run on pull requests targeting `main`, or by hand.
The build
checks the voice, SQLite, Pyodide and the sandboxes, and the server is cached so
that it downloads nothing when it starts: a published image works offline. The
big layers (dependencies, voice weights) are cached: editing the code publishes
about 50 MB.

The image is **public** (it holds the code, no secret: the keys come from
`.env.production` at run time), so the machine pulls it without any login. A
package is private the first time it is published: once, after the first run of
the workflow, GitHub, your profile, Packages, `defendable`, Package settings,
Change visibility, Public.

Then only a few files are needed, copied from the repository (for example with
`scp`) into one folder: `docker-compose.yml`, `deploy/backup.sh`,
`.env.production.example` and, for the `https` profile only, `deploy/Caddyfile`.

```bash
mkdir -p ~/defendable/deploy && cd ~/defendable
# copy the files here (deploy/backup.sh and deploy/Caddyfile into deploy/), then:
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production   # REDIRECT_URI, the keys, DEMO_PASSWORD
```

`REDIRECT_URI` is the public address (`https://…`, no trailing slash): the
personal links of the candidates start with it. Cookies are `Secure`, so the app
only works over HTTPS. `.env.production` is git-ignored and is never copied into
the image.

(Without the registry: `git clone` the repository on the machine and use
`docker compose up -d --build` instead of `pull`: the same image is built
there.)

## 3. Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f app      # "tts-ready" then "server-start"
```

The app listens on `127.0.0.1:8000` of the machine. Make it public over HTTPS in
one of these ways:

- **A tunnel of the host** (Brev: Access, expose port 8000). Open the address in
  a private window, signed out of the host: if it asks for a sign-in, visitors
  could not enter, use Caddy below.
- **Caddy, with a domain pointing at the machine** (ports 80 and 443 open):

  ```bash
  echo 'PUBLIC_HOST=demo.example.com' >> .env
  docker compose --profile https up -d --build
  ```

  Put the same address in `REDIRECT_URI`. The certificate is requested and
  renewed by itself, WebSockets go through. (`.env` next to the compose file is
  read by Compose, not by the app.)
- **cloudflared**, a named tunnel to `http://localhost:8000`, if you have a
  domain on Cloudflare.

Check from outside: the home page opens, the recruiter space signs in, and an
interview asks for the microphone (it needs HTTPS).

## 4. Run it for days

- **It restarts by itself** (`restart: unless-stopped`) after a crash or a
  reboot. The container has a health check: `docker compose ps` shows `healthy`.
- **Backups**, every 6 hours, 30 copies kept in the volume (`/data/backups`):

  Interview camera/audio recordings are stored as bounded chunks in the same
  SQLite database and included in these snapshots. Budget additional disk for
  media and backup copies (up to 100 MiB per attempt). Expired recordings are
  unavailable after 30 days and purged by the app; a recruiter can also delete
  them. These operations do not rewrite existing backup files. Apply the
  organisation's media retention/deletion policy to backups as well, and purge
  expired recordings after restoring a snapshot before exposing the service.

  ```bash
  crontab -e
  0 */6 * * * cd /home/ubuntu/defendable && ./deploy/backup.sh >> backup.log 2>&1
  ```

  Copy one out of the machine now and then:
  `docker compose cp app:/data/backups ./backups`.
- **Restore** a copy (here `defendable-X.db`, in `./backups`):

  ```bash
  docker compose stop app
  docker compose run --rm --no-deps -v "$PWD/backups:/b" --entrypoint sh app \
    -c 'rm -f /data/defendable.db-wal /data/defendable.db-shm; cp /b/defendable-X.db /data/defendable.db'
  docker compose start app
  ```
- **Update**: push to `main`, wait for the `publish` workflow (green), then on
  the machine `docker compose pull && docker compose up -d`. The database stays
  in the volume. A change of the database columns needs a new database (there is
  no migration): back it up, then `docker compose down -v` deletes the volume.
- **Logs**: `docker compose logs --since 1h app`.
- **Do not stop the machine** while the link is with the judges: the address of
  a stopped machine can change.

## 5. What is not here

- A second machine, a queue or a managed database: one process holds the jobs
  (generation, preparation, report), the events and the voice, so the app runs
  as **one** container.
- The load of several interviews at once has not been measured: the voice is
  made one sentence at a time for all the interviews.
