import { useInitWsExample } from "@/hooks/useInitWsExample";
import { wsExampleStore } from "@/stores/wsExampleStore";

export default function WebSocket() {
  useInitWsExample();

  const serverMessages = wsExampleStore((s) => s.serverMessages);
  const initHelloMessage_cb = wsExampleStore((s) => s.initHelloMessage_cb);
  const sendMessage = wsExampleStore((s) => s.sendMessage);

  return (
    <div>
      WebSocket Server messages:
      <ul>
        {serverMessages.map((m) => (
          <li key={m.replaceAll(" ", "-") + "-" + Math.random()}>{m}</li>
        ))}
      </ul>
      <button className="block my-4" onClick={initHelloMessage_cb}>
        init hello message from server
      </button>
      <button className="block" onClick={sendMessage}>
        send message
      </button>
    </div>
  );
}
