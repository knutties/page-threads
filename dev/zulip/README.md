# Local Zulip for PageThreads development

Uses [zulip/docker-zulip](https://github.com/zulip/docker-zulip). Test traffic never
leaves your machine.

Zulip 12 refuses direct plain-HTTP access (it requires a TLS-terminating reverse
proxy sending `X-Forwarded-Proto: https` — a browser can never satisfy that), so
the local server uses a **self-signed certificate**: `https://127.0.0.1:9090`.
You accept the certificate warning once per Chrome profile; after that both the
Zulip web app and the extension's API calls work.

> Note: the extension uses the `channel` narrow operator, which requires
> Zulip Server ≥ 9.0. docker-zulip's default image satisfies this.

## First-time setup

Clone upstream into this directory (the clone is gitignored):

```bash
cd dev/zulip
git clone --depth 1 https://github.com/zulip/docker-zulip.git
cd docker-zulip
```

Create `compose.override.yaml` next to upstream's `compose.yaml`:

```yaml
---
secrets:
  zulip__postgres_password:
    environment: "ZULIP__POSTGRES_PASSWORD"
  zulip__memcached_password:
    environment: "ZULIP__MEMCACHED_PASSWORD"
  zulip__rabbitmq_password:
    environment: "ZULIP__RABBITMQ_PASSWORD"
  zulip__redis_password:
    environment: "ZULIP__REDIS_PASSWORD"
  zulip__secret_key:
    environment: "ZULIP__SECRET_KEY"
  zulip__email_password:
    environment: "ZULIP__EMAIL_PASSWORD"

services:
  zulip:
    environment:
      # Must contain a dot ("localhost:9090" fails Zulip's E002 check).
      SETTING_EXTERNAL_HOST: "127.0.0.1:9090"
      SETTING_ZULIP_ADMINISTRATOR: "you@example.com"
      CERTIFICATES: "self-signed"
      # EXTERNAL_HOST is an IP, which can't host Zulip's synthetic bot/user
      # emails; without this, account registration 500s (InvalidFakeEmailDomainError).
      SETTING_FAKE_EMAIL_DOMAIN: "zulipdev.example.com"
    ports: !override
      - "9090:443"
```

Generate throwaway secrets into `.env` (same directory):

```bash
{
  echo "ZULIP__POSTGRES_PASSWORD=$(openssl rand -hex 16)"
  echo "ZULIP__MEMCACHED_PASSWORD=$(openssl rand -hex 16)"
  echo "ZULIP__RABBITMQ_PASSWORD=$(openssl rand -hex 16)"
  echo "ZULIP__REDIS_PASSWORD=$(openssl rand -hex 16)"
  echo "ZULIP__SECRET_KEY=$(openssl rand -hex 32)"
  echo "ZULIP__EMAIL_PASSWORD=unused-local-dev"
} > .env
```

Then:

```bash
docker compose up -d          # first boot takes a few minutes
docker compose exec zulip \
  sudo -u zulip /home/zulip/deployments/current/manage.py generate_realm_creation_link
```

Open the printed `https://127.0.0.1:9090/new/…` link, click through the
certificate warning (Advanced → Proceed), and create the organization and your
admin account.

> `docker compose logs -f zulip` shows first-boot progress (migrations take a
> couple of minutes before the web server answers).

## Per-realm setup for PageThreads

1. In Zulip (https://127.0.0.1:9090): create a channel named **web-threads**
   (gear icon → Channel settings → Create channel). Subscribe yourself.
2. Personal settings → Account & privacy → API key → copy it.
3. In this repo: `cp src/config.example.ts src/config.ts` and fill in
   `realmUrl: 'https://127.0.0.1:9090'`, your email, the API key.

## Second test user (for the live-updates acceptance check)

Invite a second user (Settings → Users → Invite) or reuse the realm-creation flow,
give them their own API key, and use them from a second Chrome profile with its own
`src/config.ts` build — or simply post as them from the Zulip web UI.

Notes:
- The local server has no outgoing email, so prefer the realm-creation-link flow
  (`generate_realm_creation_link`) or `manage.py create_user` over email invites.
- Each additional Chrome profile must also visit https://127.0.0.1:9090 once and
  accept the certificate before the extension's API calls will succeed there.
