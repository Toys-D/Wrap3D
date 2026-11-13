// Сборка WebView-части: webview-src/ + three.js → один обычный скрипт plugin/webview/app.js.
//
// Один файл без ES-модулей — потому что не удалось подтвердить, что WebView с локальным
// содержимым загружает модули и делает fetch локальных файлов. Запуск: npm run build

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(root, "webview-src/main.js")],
  outfile: path.join(root, "plugin/webview/app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "inline",
  logLevel: "info",
  banner: {
    js: "/* Wrap 3D — собранный файл, не редактировать. Исходники: webview-src/. Содержит three.js (лицензия MIT). */",
  },
});
