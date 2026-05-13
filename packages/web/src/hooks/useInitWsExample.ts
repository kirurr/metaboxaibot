import { wsExampleStore } from "@/stores/wsExampleStore";
import { ws } from "@/utils/ws";
import { useEffect } from "react";

export function useInitWsExample() {
  const setMessage = wsExampleStore((s) => s.setMessage);

  // register event handlers inside useEffect to avoid multiple handlers
  useEffect(() => {
    ws.connect();

    ws.on("example:recieve", (m) => {
      setMessage(m.text);
    });

    return () => {
      ws.off("example:recieve");
    };
  }, [setMessage]);
}
