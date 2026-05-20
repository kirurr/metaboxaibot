# Deployment guide

## Архитектура

| Окружение      | Сервер                   | Домены                                                                                                                                  | Compose файл               | Триггер CI/CD    |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- |
| **Prod**       | свой VPS                 | `myaibox.ai`, `tma.myaibox.ai`, `nbsp.myaibox.ai` (+ legacy: `aibox.metabox.global`, `ai.metabox.global`)                               | `docker-compose.prod.yml`  | push в `main`    |
| **Test/Stage** | общий VPS с metabox-site | `stage.myaibox.ai`, `stage.tma.myaibox.ai`, `stage.nbsp.myaibox.ai` (+ legacy: `stage.aibox.metabox.global`, `stage.ai.metabox.global`) | `docker-compose.test.yml`  | push в `develop` |
| **Local dev**  | твой ноут                | `localhost`                                                                                                                             | `docker-compose.local.yml` | вручную          |

Все домены `*.myaibox.ai` — основные (новые); `*.metabox.global` остаются как
legacy-зеркало, пока не вынесем их использование из секретов CI/конфигов
(`VITE_API_BASE_URL`, `API_PUBLIC_URL`, etc.). Web SPA и Mini App обслуживаются
одним и тем же API-контейнером (`127.0.0.1:3001` для prod, `:3002` для stage) —
nginx-конфиги отличаются только `server_name` + SSL-сертами. Поддомен `nbsp`
(`nbsp.myaibox.ai` / `stage.nbsp.myaibox.ai`) — vanity-редирект 301 на
`/admin` основного web-домена, ничего не хостит.

Pipeline в [.github/workflows](.github/workflows) собирает Docker-образы в GHCR
и пушит их на VPS через SSH. Образы статики (webapp, web) копируются на VPS
напрямую как dist-папки.

## Перед первым деплоем prod

Pipeline предполагает **подготовленный** сервер. Сделай эти шаги один раз
вручную — дальше каждый push в `main` сам доедет.

### 1. GitHub Actions secrets

В `Settings → Secrets and variables → Actions` репозитория добавь:

```
VPS_HOST                    = <prod-server-ip-or-hostname>
VPS_USER                    = root  (или другой sudo-юзер с git+docker)
VPS_SSH_KEY                 = <private-ssh-key, в формате PEM>

VITE_API_BASE_URL           = https://aibox.metabox.global/api
VITE_BOT_USERNAME           = <prod-bot-username-без-@>
VITE_LEARNING_URL           = https://...
VITE_METABOX_LANDING_URL    = https://metabox.global
VITE_METABOX_APP_URL        = https://app.metabox.global
```

Без этого webapp/web не соберутся, deploy-step не подключится по SSH.

### 2. DNS

A-записи на IP прод-сервера:

- `myaibox.ai`, `www.myaibox.ai` — Web SPA (основной)
- `tma.myaibox.ai` — Mini App + API
- `nbsp.myaibox.ai` — vanity-редирект на `myaibox.ai/admin`
- `aibox.metabox.global` — Mini App + API (legacy, оставлен на время переезда)
- `ai.metabox.global` — Web SPA (legacy, оставлен на время переезда)
- `metrics.aibox.metabox.global` — observability (для центрального
  Prometheus, см. [infra/observability/README.md](infra/observability/README.md))

Stage-VPS дополнительно держит A-записи:

- `stage.myaibox.ai` — Web SPA stage
- `stage.tma.myaibox.ai` — Mini App + API stage
- `stage.nbsp.myaibox.ai` — vanity-редирект stage
- `stage.aibox.metabox.global`, `stage.ai.metabox.global` — legacy stage

### 3. На самом VPS

Залогинься SSH-ом и сделай:

```bash
# Зависимости
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git

# Repo
sudo mkdir -p /opt/metaboxaibot && sudo chown $USER /opt/metaboxaibot
git clone https://github.com/<owner>/metaboxaibot.git /opt/metaboxaibot
cd /opt/metaboxaibot

# .env — копируй из .env.example, заполни всё. Минимум:
#   BOT_TOKEN, KEY_VAULT_MASTER, METABOX_SSO_SECRET, METABOX_INTERNAL_KEY,
#   POSTGRES_USER/PASSWORD/DB, REDIS_PASSWORD, ADMIN_SECRET,
#   все AI-ключи которые реально используешь (OPENAI_API_KEY и т.д.),
#   S3_* если хранилище включено.
cp .env.example .env
${EDITOR:-nano} .env
```

В `.env` НЕ ставь `IMAGE_TAG` и `GHCR_IMAGE_PREFIX` — pipeline сам туда
впишет нужные значения после первого успешного билда. Но если хочешь
прокатать compose до первого CI-run'а — поставь любые валидные:

```
IMAGE_TAG=latest
GHCR_IMAGE_PREFIX=ghcr.io/<repo-owner>
```

### 4. Webapp/Web статические директории

```bash
sudo mkdir -p /var/www/metabox /var/www/metabox-web
sudo chown -R www-data:www-data /var/www/metabox /var/www/metabox-web
```

Pipeline ставит `mkdir -p` сам, но nginx начнёт ругаться раньше — проще
создать сразу.

### 5. Nginx + SSL

```bash
# Симлинки уже сделает pipeline в deploy-шаге, но можно прокатать заранее
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.server.conf       /etc/nginx/sites-enabled/metabox
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.web-prod.conf     /etc/nginx/sites-enabled/metabox-web
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.myaibox-tma.conf  /etc/nginx/sites-enabled/myaibox-tma
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.myaibox-web.conf  /etc/nginx/sites-enabled/myaibox-web
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.nbsp.conf         /etc/nginx/sites-enabled/nbsp
sudo ln -sf /opt/metaboxaibot/infra/nginx/nginx.metrics.conf      /etc/nginx/sites-enabled/metabox-metrics

# SSL (Let's Encrypt) — для каждого домена
sudo certbot --nginx -d aibox.metabox.global
sudo certbot --nginx -d ai.metabox.global
sudo certbot --nginx -d myaibox.ai -d www.myaibox.ai
sudo certbot --nginx -d tma.myaibox.ai
sudo certbot --nginx -d nbsp.myaibox.ai
sudo certbot --nginx -d metrics.aibox.metabox.global

sudo nginx -t && sudo systemctl reload nginx
```

Stage-VPS (для stage-доменов на новом домене аналогично):

```bash
sudo ln -sf /opt/metaboxaibot-test/infra/nginx/nginx.web-test.conf          /etc/nginx/sites-enabled/metabox-web-test
sudo ln -sf /opt/metaboxaibot-test/infra/nginx/nginx.myaibox-tma-stage.conf /etc/nginx/sites-enabled/myaibox-tma-stage
sudo ln -sf /opt/metaboxaibot-test/infra/nginx/nginx.myaibox-web-stage.conf /etc/nginx/sites-enabled/myaibox-web-stage
sudo ln -sf /opt/metaboxaibot-test/infra/nginx/nginx.nbsp-stage.conf        /etc/nginx/sites-enabled/nbsp-stage

sudo certbot --nginx -d stage.tma.myaibox.ai
sudo certbot --nginx -d stage.myaibox.ai
sudo certbot --nginx -d stage.nbsp.myaibox.ai
```

### 6. Первый запуск контейнеров

```bash
cd /opt/metaboxaibot

# Поднять только инфру для проверки .env / volumes
docker compose -f docker-compose.prod.yml up -d postgres redis

# Когда они healthy — пушни в main, pipeline сам достроит api/bot/worker
# и поднимет их через `docker compose ... up -d`.
```

Если пушить пока не готов — можно прогнать workflow вручную:
**Actions → Prod Pipeline → Run workflow → force_all=true**.

### 7. BotFather

В `@BotFather` для прод-бота:

- `/setdomain` → `aibox.metabox.global` (нужно для login flow / SDK).
- `/newapp` или `/setmenubutton` → URL `https://aibox.metabox.global/?page=profile`
  (или какой стартовый screen у Mini App).

### 8. Observability (опционально, рекомендую)

Запустить агентов сбора логов и метрик на этом же сервере:

```bash
docker compose -f docker-compose.observability.yml up -d
```

Дальше [infra/observability/README.md](infra/observability/README.md):

- добавить scrape-job в central Prometheus (на stage-сервере metabox-site);
- проверить, что логи появляются в Grafana под `server="aibot-prod"`.

## После первого деплоя

Каждый push в `main` запускает [prod-pipeline.yml](.github/workflows/prod-pipeline.yml):

1. Lint & typecheck.
2. Detects какие сервисы изменились с прошлого деплоя (тег `prod-deployed`).
3. Билдит и пушит только их в GHCR (`ghcr.io/<owner>/metabox-{api,bot,worker}:<sha>`).
4. SSH на сервер: `git pull`, `docker compose pull <changed services>`,
   `docker compose up -d <changed services>`.
5. Симлинки nginx + `nginx -s reload`.
6. Двигает тег `prod-deployed` на новый SHA.

Webapp/web — pure static: build в CI, scp на сервер в `/var/www/metabox*`.

## Что нельзя забыть после смены домена/инфры

- Pipeline-секреты `VITE_*` пересобери, иначе SPA полезет на старый API.
- BotFather: `/setdomain` и Mini-App URL.
- DNS + SSL для нового домена.
- `METABOX_SSO_SECRET` должен совпадать в `.env` бота и сайта (если
  пользуете SSO между ними).

## Troubleshooting

**Деплой упал на `docker compose pull` с `manifest unknown`.**
GHCR-тег ещё не существует. Чаще всего это первый деплой и какой-то из
сервисов не собрался. Зайти в Actions → найти упавший build — без него
deploy не запустится. Если совсем первый раз — `Run workflow` с
`force_all=true`, чтобы все три собрались.

**Nginx `host not found in upstream`.**
docker-compose не запустил соответствующий контейнер. Проверь `docker
compose -f docker-compose.prod.yml ps`. Или у nginx неправильный
`proxy_pass` (он смотрит на `127.0.0.1:3001`, а контейнер должен быть
на этом порту).

**Бот ничего не делает после деплоя.**

1. `docker logs aibot_bot --tail 100` — ищи `Unauthorized` или
   `connection refused`.
2. `BOT_TOKEN` в `.env` — он от прод-бота? Не перепутали с тестовым?
3. `TELEGRAM_TEST_ENV` в `.env` — должен быть `0`/отсутствовать, иначе
   бот стучится в test DC и получает 401.

**API отвечает 502.**
Контейнер api упал. `docker logs aibot_api`. Часто ругается на отсутствующий
обязательный env (`KEY_VAULT_MASTER` сейчас required, без него процесс
падает на старте).

**Миграции БД не применились.**
Они применяются `entrypoint.sh` в каждом контейнере (api/bot/worker) на
старте через `prisma migrate deploy`. Если все три упали и крутятся в
рестарт-loop — `docker logs aibot_api` покажет в чём затык. Чаще всего
нет коннекта к postgres или схема в БД конфликтует с миграцией.
