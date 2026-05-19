import { useEffect, useState } from "react";

/** Создаёт ObjectURL для локального File-preview, чистит при размонтировании. */
export function useObjectUrl(file: File, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, enabled]);
  return url;
}
