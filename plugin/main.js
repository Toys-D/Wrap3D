"use strict";
/*
 * Wrap 3D — точка входа панели (сторона UXP).
 *
 * UXP-часть тонкая: она читает пиксели слоя, вставляет результат в документ и хранит
 * настройки. Интерфейс и рендер находятся в WebView (plugin/webview).
 *
 * Все модули подключаются отсюда и друг друга не подключают, чтобы работа не зависела
 * от того, как UXP разрешает относительные пути во вложенных require.
 */
(function () {
  var TAG = "[Wrap3D]";

  function log(level, text) {
    var fn = console[level] || console.log;
    fn.call(console, TAG + "[uxp] " + text);
  }

  var uxp, photoshop, transfer, createPhotoshopApi, createStorage;
  try {
    uxp = require("uxp");
    photoshop = require("photoshop");
    transfer = require("./src/transfer.js");
    createPhotoshopApi = require("./src/photoshop.js").createPhotoshopApi;
    createStorage = require("./src/storage.js").createStorage;
  } catch (e) {
    log("error", "не удалось подключить модули: " + (e && e.message));
    return;
  }

  function hostInfo() {
    var info = { ps: "?", uxp: "?", plugin: "?", locale: "", os: "?" };
    try {
      info.ps = String(uxp.host.version);
      info.locale = String(uxp.host.uiLocale || "");
    } catch (e) {}
    try {
      info.uxp = String(uxp.versions.uxp);
      info.plugin = String(uxp.versions.plugin);
    } catch (e) {}
    try {
      var os = require("os");
      info.os = os.platform() + " " + os.release();
    } catch (e) {}
    return info;
  }

  /**
   * Файлы в папке данных плагина (getDataFolder — без запроса к пользователю, папка переживает
   * обновления Photoshop). undefined, если файловое API недоступно.
   */
  function createFileStore() {
    var lfs = uxp.storage && uxp.storage.localFileSystem;
    if (!lfs || typeof lfs.getDataFolder !== "function") return undefined;
    return {
      read: async function (name) {
        var folder = await lfs.getDataFolder();
        var entry;
        try {
          entry = await folder.getEntry(name);
        } catch (e) {
          return null; // файла ещё нет
        }
        return await entry.read();
      },
      write: async function (name, text) {
        var folder = await lfs.getDataFolder();
        var file = await folder.createFile(name, { overwrite: true });
        await file.write(text);
      },
    };
  }

  function init() {
    var webview = document.getElementById("wrap3dView");
    if (!webview) {
      log("error", "элемент <webview> не найден");
      return;
    }

    var storage = createStorage(window.localStorage, log, createFileStore());
    var ps = createPhotoshopApi(photoshop, log);
    var bridge = transfer.createBridge({
      name: "uxp",
      log: log,
      post: function (text) {
        webview.postMessage(text);
      },
    });
    var gotReady = false;

    // WebView → UXP: по документации приходит событием message на window.
    window.addEventListener("message", function (e) {
      bridge.receive(e.data);
    });

    webview.addEventListener("loadstart", function (e) {
      log("log", "webview loadstart " + e.url);
    });
    webview.addEventListener("loadstop", function (e) {
      log("log", "webview loadstop " + e.url);
      if (webview.clientHeight !== undefined && webview.clientHeight < 40) {
        var h = document.body.clientHeight || window.innerHeight || 600;
        webview.style.height = h + "px";
        log("warn", "высота webview была " + webview.clientHeight + " px, задана явно: " + h + " px");
      }
      setTimeout(function () {
        if (!gotReady) {
          log("error", "WebView загружен, но сообщение ready не пришло за 5 с — мост WebView → UXP не работает");
        }
      }, 5000);
    });
    webview.addEventListener("loaderror", function (e) {
      log("error", "webview loaderror " + e.url + " code=" + e.code + " " + e.message);
    });

    bridge.on("ready", function (info) {
      if (!gotReady) {
        gotReady = true;
        log("log", "ready от WebView: " + JSON.stringify(info));
      }
      // Вместе с приветствием уходят пресеты контуров и параметры последнего применения.
      Promise.all([storage.readJson("presets.json"), storage.readJson("last.json")])
        .then(function (data) {
          bridge.emit("hello", { settings: storage.load(), host: hostInfo(), presets: data[0], last: data[1] });
        })
        .catch(function (e) {
          log("error", "сохранённые данные не прочитаны: " + (e && e.message));
          bridge.emit("hello", { settings: storage.load(), host: hostInfo(), presets: null, last: null });
        });
    });

    bridge.on("log", function (m) {
      var level = m && console[m.level] ? m.level : "log";
      console[level](TAG + "[webview] " + (m && m.text));
    });

    bridge.handle("getLayer", async function (p) {
      var res = await ps.readSelectedLayer(p);
      return { result: res.info, blob: res.pixels };
    });

    bridge.handle("getSnapshot", async function (p) {
      var res = await ps.readDocumentSnapshot(p);
      return { result: res.info, blob: res.pixels };
    });

    bridge.handle("apply", async function (p, pixels) {
      return { result: await ps.applyResult(p, pixels) };
    });

    // Тест скорости передачи: возвращает полученные данные обратно.
    bridge.handle("echo", async function (p, data) {
      return { result: { bytes: data ? data.length : 0 }, blob: data, chunkBytes: p.chunkBytes };
    });

    bridge.handle("saveSettings", async function (p) {
      return { result: storage.save(p || {}) };
    });

    bridge.handle("savePresets", async function (p) {
      return { result: { stored: await storage.writeJson("presets.json", (p && p.presets) || []) } };
    });

    bridge.handle("saveLast", async function (p) {
      return { result: { stored: await storage.writeJson("last.json", (p && p.last) || null) } };
    });

    log("log", "панель запущена: " + JSON.stringify(hostInfo()));
  }

  try {
    if (document.getElementById("wrap3dView")) init();
    else document.addEventListener("DOMContentLoaded", init);
  } catch (e) {
    log("error", "ошибка запуска: " + (e && e.message) + "\n" + (e && e.stack));
  }
})();
