/**
 * Helper, который делает из ProxyConfig fetch-функцию, маршрутизирующую трафик
 * через указанный прокси (используя undici ProxyAgent).
 *
 * Возвращает null если прокси не задан — в этом случае адаптер должен
 * использовать глобальный fetch как раньше.
 *
 * Зачем: SDK провайдеров (OpenAI, Anthropic, …) принимают опцию `fetch`,
 * через которую можно подменить транспорт. Адаптеры на чистом fetch
 * также принимают опциональный `fetch`-параметр.
 */

import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { ProxyConfig } from "../../services/key-pool.service.js";

export function buildProxyFetch(proxy: ProxyConfig | null): typeof fetch | null {
  if (!proxy) return null;

  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : "";
  const uri = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
  const agent = new ProxyAgent({ uri });

  // undici fetch имеет немного отличающуюся типизацию от глобального fetch
  // (Headers / Request / Response классы), но в рантайме они совместимы.
  return ((url: string | URL | Request, init?: RequestInit) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undiciFetch(url as any, {
      ...(init as any),
      dispatcher: agent,
      // undici v7 requires duplex: 'half' for any request with a body
      duplex: "half",
    }) as unknown as Promise<Response>) as typeof fetch;
}
