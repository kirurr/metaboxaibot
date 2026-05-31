/**
 * Точечный прогрев картинок в кеш браузера — чтобы при открытии preview-модалки
 * полноразмерный URL уже был в Disk/Memory Cache и `<img src>` отдавался мгновенно.
 * Используется в hover'ах тайлов и для prev/next в модалке. Кэширует Promise
 * по URL, повтор — no-op.
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
