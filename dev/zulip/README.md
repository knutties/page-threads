# Local Zulip for PageThreads development

Uses [zulip/docker-zulip](https://github.com/zulip/docker-zulip). Test traffic never
leaves your machine.

## First-time setup

```bash
git clone --depth 1 https://github.com/zulip/docker-zulip.git
cd docker-zulip
```

Edit `docker-compose.yml` under the `zulip:` service:

1. Change the port mapping to `"9090:80"` (and remove/ignore the 443 mapping).
2. In `environment:`, set:
   - `SETTING_EXTERNAL_HOST: "localhost:9090"`
   - `SETTING_ZULIP_ADMINISTRATOR: "you@example.com"`
   - `DISABLE_HTTPS: "True"`  (Chrome treats http://localhost as a secure context,
     and it avoids self-signed-cert issues with extension fetches)

Then:

```bash
docker compose up -d          # first boot takes a few minutes
docker compose exec zulip \
  sudo -u zulip /home/zulip/deployments/current/manage.py generate_realm_creation_link
```

Open the printed link (replace the host with `localhost:9090` if needed) and create
the organization and your admin account.

> If any setting name above has drifted in docker-zulip, `docker compose logs zulip`
> says so explicitly; the authoritative list is in docker-zulip's README table of
> `SETTING_*`/`DISABLE_HTTPS` variables.

## Per-realm setup for PageThreads

1. In Zulip (http://localhost:9090): create a channel named **web-threads**
   (gear icon → Channel settings → Create channel). Subscribe yourself.
2. Personal settings → Account & privacy → API key → copy it.
3. In this repo: `cp src/config.example.ts src/config.ts` and fill in
   `realmUrl: 'http://localhost:9090'`, your email, the API key.

## Second test user (for the live-updates acceptance check)

Invite a second user (Settings → Users → Invite) or reuse the realm-creation flow,
give them their own API key, and use them from a second Chrome profile with its own
`src/config.ts` build — or simply post as them from the Zulip web UI.
