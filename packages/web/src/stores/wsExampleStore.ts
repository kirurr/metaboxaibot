import { ws } from "@/utils/ws";
import { create } from "zustand";

interface WSExampleStore {
  connected: boolean;
  serverMessages: string[];

  initHelloMessage_cb: () => Promise<void>;
  setMessage: (message: string) => void;

  sendMessage: () => void;
}

export const wsExampleStore = create<WSExampleStore>((set, get) => ({
  connected: false,
  serverMessages: [],

  initHelloMessage_cb: async () => {
    await fetch("http://localhost:3001/ws/hello");
  },

  sendMessage: () => {
    ws.emit("example:send", { text: "Hello from client" });
  },

  setMessage: (message) => set({ serverMessages: [...get().serverMessages, message] }),
}));
