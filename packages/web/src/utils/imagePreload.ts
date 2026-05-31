/**
 * Прогрев картинок в кеш браузера — чтобы при открытии preview-модалки
 * полноразмерный URL уже был в Disk/Memory Cache и `<img src>` отдавался мгновенно.
 *
 * Два слоя:
 *  - `preloadImage` — точечный прогрев (hover, prev/next в модалке, progressive
 *    fallback). Кэширует Promise по URL, повтор — no-op.
 *  - `queuePreload` — фоновый прогрев из viewport-обсёрверов. Лимит 2
 *    параллельных запроса — больше начинает заметно лагать main thread на
 *    декодинге картинок при скролле грида.
 */
type Priority = "high" | "low" | "auto";

const cache = new Map<string, Promise<void>>();

export function preloadImage(url: string, priority: Priority = "auto"): Promise<void> {
  const existing = cache.get(url);
  if (existing) return existing;

  const p = new Promise<void>((resolve) => {
    const img = new Image();
    if (priority !== "auto") {
      // fetchPriority доступен в современных браузерах; TS-типы есть в React 19+.
      img.fetchPriority = priority;
    }
    img.onload = () => resolve();
    img.onerror = () => {
      cache.delete(url); // дать шанс ретраю
      resolve();
    };
    img.src = url;
  });
  cache.set(url, p);
  return p;
}

const MAX_PARALLEL = 2;
let active = 0;
const queue: string[] = [];
const queued = new Set<string>();

function pump(): void {
  while (active < MAX_PARALLEL && queue.length > 0) {
    const url = queue.shift()!;
    queued.delete(url);
    active++;
    preloadImage(url).finally(() => {
      active--;
      pump();
    });
  }
}

export function queuePreload(url: string): void {
  if (cache.has(url) || queued.has(url)) return;
  queued.add(url);
  queue.push(url);
  pump();
}
