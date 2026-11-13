// Мост WebView → UXP. Протокол общий с UXP-частью (plugin/src/transfer.js).
import transfer from "../plugin/src/transfer.js";

export function createWebviewBridge(log) {
  const bridge = transfer.createBridge({
    name: "webview",
    log,
    post: (text) => {
      // window.uxpHost добавляет в страницу сам UXP (документация HTMLWebViewElement).
      const host = window.uxpHost;
      if (!host || typeof host.postMessage !== "function") {
        throw transfer.makeError("noHost", "window.uxpHost недоступен");
      }
      host.postMessage(text);
    },
  });
  // UXP → WebView приходит событием message на window.
  window.addEventListener("message", (e) => bridge.receive(e.data));
  return bridge;
}
