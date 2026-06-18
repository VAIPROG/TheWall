import { cfg } from "./config";
import { SEL } from "./constants";
import { log } from "./log";

type EventCallback = (data?: any) => void;

const map: Record<string, EventCallback[]> = {};

export const WallEvents = {
  on(ev: string, cb: EventCallback): void {
    (map[ev] = map[ev] || []).push(cb);
  },
  emit(ev: string, d?: any): void {
    (map[ev] || []).forEach((cb) => {
      try { cb(d); } catch (e: any) { log("EVENT", "ERR", e.toString()); }
    });
  },
  startDom(): void {
    const list = document.querySelector(SEL.chatList);
    if (list) {
      new MutationObserver((muts) =>
        muts.forEach((m) =>
          m.addedNodes.forEach((n) => n.nodeType === 1 && WallEvents.emit("chat", n)),
        ),
      ).observe(list, { childList: true });
    }
    const badge = document.querySelector(SEL.notifBadge);
    if (badge)
      new MutationObserver(() =>
        WallEvents.emit("notifBadge", badge.textContent),
      ).observe(badge, { childList: true, characterData: true, subtree: true });
  },
  startWsTap(): void {
    if (!cfg.wsTap || (window as any).__WALL_WS_TAP__) return;
    (window as any).__WALL_WS_TAP__ = true;
    const Native = window.WebSocket;
    (window as any).WebSocket = function (url: string, proto?: string | string[]) {
      const ws = proto ? new Native(url, proto) : new Native(url);
      if (String(url).includes("filianislost")) {
        log("WS_TAP", "OK", "attached passive mirror to " + url);
        ws.addEventListener("message", (e: MessageEvent) =>
          WallEvents.emit("ws", { url, data: e.data }),
        );
        ws.addEventListener("open", () => WallEvents.emit("wsState", "OPEN"));
        ws.addEventListener("close", () => WallEvents.emit("wsState", "CLOSED"));
      }
      return ws;
    };
    (window as any).WebSocket.prototype = Native.prototype;
    Object.assign((window as any).WebSocket, Native);
  },
};
