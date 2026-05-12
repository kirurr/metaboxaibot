/**
 * Тонкая обёртка над fetch для скачивания видео от провайдеров.
 *
 * Зачем нужно: undici-fetch бросает `TypeError: fetch failed: unknown scheme`
 * на любом URL'е, scheme которого не {http, https, blob, data, file}. У нас
 * проскальзывают такие URL'ы из аггрегаторов (evolink/KIE/etc.) когда они
 * возвращают внутренние идентификаторы вроде `gs://...`, `task://...`, либо
 * пустую/невалидную строку. Сырая ошибка undici НЕ содержит самого URL'а в
 * сообщении, поэтому в логах не видно ЧТО конкретно не получилось — каждый
 * расследовать приходится по providerJobId.
 *
 * Этот helper:
 *   1. Pre-валидирует scheme — если не http(s), сразу бросает Error с URL'ом
 *      внутри сообщения, не доходя до fetch (видно в техническом alert'е).
 *   2. После fetch'а — если !ok, бросает Error с URL + status.
 *   3. На успехе возвращает Response (как обычный fetch).
 *
 * НЕ предназначен для аутентифицированных скачиваний (Veo API key и т.п.) —
 * там адаптер должен реализовать свой `fetchBuffer`.
 */
export async function fetchVideoUrl(url: string, label: string): Promise<Response> {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${label}: empty or non-string URL from provider`);
  }
  if (!/^https?:\/\//i.test(url)) {
    // urlPreview: первые 200 символов, чтобы в alert'е не было гигантских base64.
    const preview = url.length > 200 ? url.slice(0, 200) + "…" : url;
    throw new Error(`${label}: provider returned non-http(s) URL: ${preview}`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} from ${url}`);
  }
  return res;
}
