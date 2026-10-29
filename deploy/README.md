# Deploying Defendable on one machine

One container serves everything: the API, the voice interview (WebSocket), the
web app, the voice of Oracle and the sandboxes. The database is a SQLite file in
a Docker volume. Sized for a machine with **4 fast cores or more and 8 GB of
memory** (the voice takes about 1 GB and wants the cores: run
`docker compose exec app deno task tts:bench` and read the last line).

## 1. The machine

Any Linux x86-64 machine with Docker and the Compose plugin (`docker compose`).
On a Brev VM:

```bash
docker --version || curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and in again
```

Disk: 40 GB is comfortable (the image is about 3 GB, with the voice model in
it).

## 2. The code and the secrets

```bash
git clone https://github.com/Mirak29/defendable && cd defendable
cp .env.production.example .env.production
nano .env.production   # REDIRECT_URI, the keys, DEMO_PASSWORD
```

`REDIRECT_URI` is the public address (`https://…`, no trailing slash): the
personal links of the candidates start with it. Cookies are `Secure`, so the app
only works over HTTPS. `.env.production` is git-ignored and is never copied into
the image.

## 3. Start

```bash
docker compose up -d --build
docker compose logs -f app      # "tts-ready" then "server-start"
```

The first build downloads everything the server needs offline (the native SQLite
library, the voice model, Pyodide) and **runs a check of each**: if the build
succeeds, the sandboxes and the voice work in the image. It takes several
minutes; the next builds reuse the layers.

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
- **Update**: `git pull && docker compose up -d --build`. The database stays in
  the volume. A change of the database columns needs a new database (there is no
  migration): back it up, then `docker compose down -v` deletes the volume.
- **Logs**: `docker compose logs --since 1h app`.
- **Do not stop the machine** while the link is with the judges: the address of
  a stopped machine can change.

## 5. What is not here

- A second machine, a queue or a managed database: one process holds the jobs
  (generation, preparation, report), the events and the voice, so the app runs
  as **one** container.
- The load of several interviews at once has not been measured: the voice is
  made one sentence at a time for all the interviews.
