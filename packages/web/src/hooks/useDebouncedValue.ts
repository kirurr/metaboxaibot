import { useEffect, useState } from "react";

/**
 * Возвращает значение, обновляющееся не чаще раз в `delay` миллисекунд после
 * последнего изменения. Используется для серверного поиска: вводимый текст
 * (мгновенный) → debounced версия (идёт в queryKey).
 *
 * Отличие от React `useDeferredValue`: тут жёсткая задержка по времени, а не
 * priority-based throttle планировщика. Их можно комбинировать — debounced
 * значение для сетевого запроса, deferred — для тяжёлых клиентских вычислений.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
