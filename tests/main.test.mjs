// Проверка точки входа панели (plugin/main.js) целиком: файл запускается в песочнице
// с имитацией окружения UXP, а со стороны WebView к нему подключается настоящий мост.

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fakePhotoshop } from "./helpers/fake-photoshop.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const transfer = require("../plugin/src/transfer.js");

function bootPanel(options = {}) {
  const fake = options.fake || fakePhotoshop();
  const windowListeners = {};
  const webviewListeners = {};
  const consoleLines = [];
  const store = new Map(Object.entries(options.stored || {}));
  let webBridge = null;

  // Папка данных плагина: getEntry / createFile / read / write — как в документации UXP.
  const files = new Map(Object.entries(options.files || {}));
  const fileEntry = (name) => ({
    read: async () => files.get(name),
    write: async (text) => {
      files.set(name, text);
      return text.length;
    },
  });
  const dataFolder = {
    getEntry: async (name) => {
      if (!files.has(name)) throw new Error("Could not find an entry of '" + name + "'");
      return fileEntry(name);
    },
    createFile: async (name, opts) => {
      if (files.has(name) && !(opts && opts.overwrite)) throw new Error("File exists");
      return fileEntry(name);
    },
  };

  const webview = {
    clientHeight: 500,
    style: {},
    postMessage: (text) => setTimeout(() => webBridge.receive(text), 0),
    addEventListener: (name, fn) => (webviewListeners[name] = fn),
  };
  const sandbox = {
    require: (name) => {
      if (name === "uxp") {
        return {
          host: { version: "26.2.0", uiLocale: "ru_RU" },
          versions: { uxp: "uxp-8.1.0", plugin: "0.1.0" },
          storage: options.noFiles ? undefined : { localFileSystem: { getDataFolder: async () => dataFolder } },
        };
      }
      if (name === "photoshop") return fake.ps;
      if (name === "os") return { platform: () => "darwin", release: () => "27.0.0" };
      if (name.startsWith("./")) return require(path.join(root, "plugin", name));
      throw new Error("неизвестный модуль: " + name);
    },
    document: {
      getElementById: (id) => (id === "wrap3dView" ? webview : null),
      addEventListener() {},
      body: { clientHeight: 600 },
    },
    window: {
      addEventListener: (name, fn) => (windowListeners[name] = fn),
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
      innerHeight: 600,
    },
    console: Object.fromEntries(
      ["log", "info", "warn", "error", "debug"].map((level) => [level, (...a) => consoleLines.push([level, a.join(" ")])]),
    ),
    setTimeout,
    clearTimeout,
  };

  const code = fs.readFileSync(path.join(root, "plugin/main.js"), "utf8");
  vm.runInNewContext(code, sandbox, { filename: "plugin/main.js" });

  webBridge = transfer.createBridge({
    name: "webview",
    post: (text) => setTimeout(() => windowListeners.message({ data: text }), 0),
  });
  return { webBridge, consoleLines, store, fake, webviewListeners, files };
}

const once = (bridge, event) => new Promise((resolve) => bridge.on(event, resolve));

test("панель запускается без ошибок и подписывается на сообщения WebView", () => {
  const { consoleLines, webviewListeners } = bootPanel();
  assert.deepEqual(consoleLines.filter(([level]) => level === "error"), []);
  assert.equal(typeof webviewListeners.loadstop, "function");
  assert.equal(typeof webviewListeners.loaderror, "function");
});

test("на ready панель отвечает hello с сохранённым языком и версией Photoshop", async () => {
  const { webBridge } = bootPanel({ stored: { "wrap3d.settings": JSON.stringify({ lang: "en" }) } });
  const hello = once(webBridge, "hello");
  webBridge.emit("ready", { caps: { maxTextureSize: 16384 } });
  const payload = await hello;
  assert.deepEqual(payload.settings, { lang: "en" });
  assert.equal(payload.host.ps, "26.2.0");
  assert.equal(payload.host.locale, "ru_RU");
  assert.equal(payload.host.uxp, "uxp-8.1.0");
});

test("getLayer через мост отдаёт сведения о слое и его пиксели", async () => {
  const { webBridge, fake } = bootPanel();
  const res = await webBridge.call("getLayer", { maxSize: 8192 });
  assert.equal(res.result.layerName, "Logo");
  assert.equal(res.result.srcWidth, 900);
  assert.equal(res.result.srcHeight, 260);
  assert.deepEqual(res.blob, fake.layerPixels);
});

test("apply через мост вставляет полученные пиксели в документ", async () => {
  const { webBridge, fake } = bootPanel();
  const pixels = new Uint8Array(4 * 2 * 4).map((_, i) => i);
  const res = await webBridge.call(
    "apply",
    { docId: 5, left: 300, top: 400, width: 4, height: 2, name: "Logo — Wrap 3D" },
    { blob: pixels },
  );
  assert.equal(res.result.layerId, 99);
  const put = fake.calls.find((c) => c[0] === "putPixels")[1];
  assert.deepEqual(put.targetBounds, { left: 300, top: 400 });
  const written = fake.calls.find((c) => c[0] === "createImageDataFromBuffer")[1];
  assert.deepEqual(written, pixels);
});

test("getSnapshot через мост отдаёт снимок документа для фона", async () => {
  const { webBridge } = bootPanel();
  const res = await webBridge.call("getSnapshot", { maxSize: 800 });
  assert.deepEqual({ w: res.result.width, h: res.result.height, c: res.result.components }, { w: 800, h: 600, c: 3 });
  assert.equal(res.blob.length, 800 * 600 * 3);
});

test("ошибка Photoshop доходит до WebView с кодом", async () => {
  const { webBridge } = bootPanel({ fake: fakePhotoshop({ activeDocument: null }) });
  await assert.rejects(webBridge.call("getLayer", {}), (e) => e.code === "noDocument");
});

test("saveSettings сохраняет язык на стороне UXP", async () => {
  const { webBridge, store } = bootPanel();
  const res = await webBridge.call("saveSettings", { lang: "en" });
  assert.deepEqual(res.result, { lang: "en" });
  assert.deepEqual(JSON.parse(store.get("wrap3d.settings")), { lang: "en" });
});

test("echo возвращает данные обратно кусками запрошенного размера", async () => {
  const { webBridge } = bootPanel();
  const data = new Uint8Array(9000).map((_, i) => (i * 7) & 255);
  const res = await webBridge.call("echo", { chunkBytes: 3000 }, { blob: data });
  assert.deepEqual(res.blob, data);
  assert.equal(res.rx.chunks, 3);
});

test("журнал WebView попадает в консоль UXP с пометкой источника", async () => {
  const { webBridge, consoleLines } = bootPanel();
  webBridge.emit("log", { level: "warn", text: "проверка журнала" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    consoleLines.some(([level, line]) => level === "warn" && line === "[Wrap3D][webview] проверка журнала"),
    JSON.stringify(consoleLines),
  );
});

test("hello несёт сохранённые пресеты и параметры последнего применения", async () => {
  const { webBridge } = bootPanel({
    files: {
      "presets.json": JSON.stringify([{ id: "p1", name: "Бутылка", points: [] }]),
      "last.json": JSON.stringify({ layerId: 12, docName: "bottle.psd" }),
    },
  });
  const hello = once(webBridge, "hello");
  webBridge.emit("ready", {});
  const payload = await hello;
  assert.deepEqual(payload.presets, [{ id: "p1", name: "Бутылка", points: [] }]);
  assert.deepEqual(payload.last, { layerId: 12, docName: "bottle.psd" });
});

test("hello без сохранённых данных несёт пустые значения", async () => {
  const { webBridge } = bootPanel();
  const hello = once(webBridge, "hello");
  webBridge.emit("ready", {});
  const payload = await hello;
  assert.equal(payload.presets, null);
  assert.equal(payload.last, null);
});

test("savePresets и saveLast пишут файлы в папку данных плагина", async () => {
  const { webBridge, files } = bootPanel();
  await webBridge.call("savePresets", { presets: [{ id: "p1", name: "А", points: [] }] });
  await webBridge.call("saveLast", { last: { layerId: 5 } });
  assert.deepEqual(JSON.parse(files.get("presets.json")), [{ id: "p1", name: "А", points: [] }]);
  assert.deepEqual(JSON.parse(files.get("last.json")), { layerId: 5 });
});

test("без файлового API пресеты сохраняются в localStorage UXP", async () => {
  const { webBridge, store, consoleLines } = bootPanel({ noFiles: true });
  await webBridge.call("savePresets", { presets: [{ id: "p1" }] });
  const saved = [...store.values()].some((v) => v.includes('"p1"'));
  assert.ok(saved, "данные в localStorage");
  assert.deepEqual(consoleLines.filter(([level]) => level === "error"), []);
});

test("getLayer с layerId читает слой по номеру для восстановления сцены", async () => {
  const fake = fakePhotoshop();
  fake.ps.app.activeDocument.activeLayers = [];
  fake.ps.app.activeDocument.layers = [fake.layer];
  const { webBridge } = bootPanel({ fake });
  const res = await webBridge.call("getLayer", { layerId: 12, maxSize: 8192 });
  assert.equal(res.result.layerId, 12);
});
