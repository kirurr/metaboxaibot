# Observability — metaboxaibot prod

Что делаем: на прод-сервере бота поднимаем агенты сбора (promtail для логов

- node-exporter / cAdvisor для метрик). Они шлют данные в центральный стек
  (Loki + Prometheus + Grafana), который уже работает на stage-сервере
  проекта `metabox-site`. Так в одной Grafana будут видны и сайт, и бот.

## Поток данных

```
metaboxaibot prod                     stage server (metabox-site)
─────────────────                     ──────────────────────────
  promtail                  push      Loki   ← grafana.stage.meta-box.ru
   └── docker logs ─────────────────►  (loki.stage.meta-box.ru/loki/api/v1/push)
  node-exporter:9100   ◄── scrape
  cadvisor:8080        ◄── scrape ─── Prometheus
   (через host nginx +                 (метки server={aibot-prod|prod|stage})
    HTTPS на metrics.aibox.metabox.global)
```

`server`-лейбл в Grafana разделяет источники:

- `aibot-prod` — этот сервер (бот);
- `prod` — прод-сервер сайта (metabox-site);
- `stage` — stage-сервер сайта (там же где и центральный Loki/Prom/Grafana).

## Docker daemon configuration

Промтейл читает docker-логи **напрямую с диска**
(`/var/lib/docker/containers/*/*-json.log`), а не через docker daemon API.
Это решает баг live-streaming endpoint'а в Docker 29.4 / containerd 2.2.3,
когда `docker logs --follow` тихо зависает на idle-контейнерах и кладёт
сбор логов через `docker_sd_configs` (см. инцидент 2026-05-24).

Чтобы `service`-лейбл в Loki содержал имя контейнера (а не container_id),
docker должен подмешивать имя в каждую строку json-лога через log-opts.
Создай или допиши `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "tag": "{{.Name}}",
    "max-size": "10m",
    "max-file": "3"
  }
}
```

- `tag: "{{.Name}}"` — в каждой строке json-лога будет `attrs.tag` с именем
  контейнера. Промтейл его парсит и кладёт в label `service`.
- `max-size: "10m"` + `max-file: "3"` — автоматическая ротация json-файлов
  на 10 MB × 3 копии. Профилактика накопления sparse-corruption'а
  (когда-то у cadvisor'а одна «строка» из NULL-блоков выросла до 80 MB
  и валила Loki rate-limit'ом).

Применить:

```bash
sudo systemctl restart docker
```

⚠️ Это **рестартует все контейнеры на хосте** (~30 сек даунтайма).
Контейнеры с `restart: always` (наш стек) поднимутся сами. log-opts
применяется только к НОВЫМ контейнерам — поэтому после рестарта daemon'а
все запущенные контейнеры будут пересозданы и получат тег.

Проверить, что тег записывается:

```bash
# для любого контейнера — должен быть "attrs":{"tag":"<container_name>"}
sudo tail -n 1 /var/lib/docker/containers/$(docker inspect -f '{{.Id}}' aibot_api)/*-json.log | jq .attrs
```

## Деплой на прод-сервере бота

### 1. DNS

Создай A-запись `metrics.aibox.metabox.global` → IP этого сервера.

### 2. SSL

```bash
certbot --nginx -d metrics.aibox.metabox.global
```

### 3. Host nginx

```bash
sudo ln -sf /opt/metabox/infra/nginx/nginx.metrics.conf \
            /etc/nginx/sites-available/metabox-metrics
sudo ln -sf /etc/nginx/sites-available/metabox-metrics \
            /etc/nginx/sites-enabled/metabox-metrics
sudo nginx -t && sudo systemctl reload nginx
```

`limit_req_zone api_limit` уже определён в существующем
[`nginx.server.conf`](../nginx/nginx.server.conf) — отдельно описывать
не нужно.

### 4. Запуск агентов

```bash
cd /opt/metabox
docker compose -f docker-compose.observability.yml up -d
```

Проверь, что всё поднялось:

```bash
docker compose -f docker-compose.observability.yml ps
docker logs aibot_promtail --tail 20
curl -s http://127.0.0.1:9100/metrics | head -3
curl -s http://127.0.0.1:8080/metrics | head -3
curl -s https://metrics.aibox.metabox.global/node | head -3   # 200 OK
```

### 5. Проверь, что логи идут в Loki

С stage-сервера:

```bash
curl -s 'http://127.0.0.1:3300/loki/api/v1/label/server/values' | jq
# Должно появиться "aibot-prod" в списке
```

## На stage-сервере: добавить scrape jobs в Prometheus

В `monitoring/prometheus.yml` проекта **metabox-site** добавь под существующие
job'ы про prod-сервер сайта (`metrics.metabox.global`):

```yaml
# ── metaboxaibot prod ─────────────────────────────────────────────────
- job_name: node-exporter-aibot-prod
  scheme: https
  metrics_path: /node
  static_configs:
    - targets: ["metrics.aibox.metabox.global"]
      labels:
        server: aibot-prod

- job_name: cadvisor-aibot-prod
  scheme: https
  metrics_path: /cadvisor
  static_configs:
    - targets: ["metrics.aibox.metabox.global"]
      labels:
        server: aibot-prod
```

Перечитать конфиг без рестарта:

```bash
docker exec meta-box-stage-prometheus-1 kill -HUP 1
# либо
curl -X POST http://127.0.0.1:9090/-/reload
```

Проверь, что Prometheus подключился: открой в Grafana
`https://grafana.stage.meta-box.ru` → Explore → Prometheus → запрос
`up{server="aibot-prod"}` — должны быть две единички (node + cadvisor).

## Дашборды

В Grafana уже должны быть дашборды по `server` лейблу. Если стандартные
node-exporter / cadvisor дашборды не фильтруют по этому лейблу — открой
их Variables → добавь `$server` (label_values(up, server)).

## Troubleshooting

**Логов из бот-прода нет в Grafana.** Сначала проверь:

```bash
docker logs aibot_promtail --tail 50
```

Если видишь повторяющиеся `connection refused` или `tls: handshake failure` —
проблема в DNS или сертификатах stage-стороны. Если `429 Too Many Requests`
от `loki.stage.meta-box.ru` — уперлись в `limit_req` на nginx stage сервера.

**`up{server="aibot-prod"}` показывает 0.** Prometheus на stage не может
достучаться до `metrics.aibox.metabox.global`. Проверь:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://metrics.aibox.metabox.global/node
```

Должен быть 200. Если 403 — какой-то домен/нгинкс-конфликт. Если timeout —
firewall у бота режет.

**Promtail падает по OOM.** `mem_limit: 128m` в нашем compose. При большом
объёме docker-логов может быть тесно — подними до 256m. Параллельно
проверь, что `promtail-positions` volume действительно монтируется
(`docker volume inspect metaboxaibot_promtail-positions`).
