"use strict";
/*
 * Wrap 3D — хранение данных на стороне UXP.
 *
 * В WebView с локальным содержимым localStorage недоступен (документация Adobe),
 * поэтому всё хранит UXP:
 *   - язык интерфейса — в localStorage UXP (мелочь, которую легко задать заново);
 *   - пресеты контуров и параметры последнего применения — файлами JSON в папке данных
 *     плагина: документация предупреждает, что localStorage могут очистить.
 *     Если файл записать не удалось, данные уходят в localStorage, чтобы не пропасть.
 *
 * fileStore — { read(name) → Promise<string|null>, write(name, text) → Promise }.
 */

var KEY = "wrap3d.settings";
var FILE_PREFIX = "wrap3d.file.";

function createStorage(store, log, fileStore) {
  log = log || function () {};
  var memory = {};

  function load() {
    try {
      var text = store.getItem(KEY);
      if (text) {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") memory = parsed;
      }
    } catch (e) {
      log("warn", "настройки не прочитаны: " + (e && e.message));
    }
    return Object.assign({}, memory);
  }

  function save(patch) {
    memory = Object.assign(load(), patch);
    try {
      store.setItem(KEY, JSON.stringify(memory));
    } catch (e) {
      log("warn", "настройки не сохранены: " + (e && e.message));
    }
    return Object.assign({}, memory);
  }

  /** Читает JSON по имени файла; null — если данных нет или они испорчены. */
  async function readJson(name) {
    var text = null;
    if (fileStore) {
      try {
        text = await fileStore.read(name);
      } catch (e) {
        log("warn", "файл " + name + " не прочитан: " + (e && e.message));
        text = null;
      }
    }
    if (text === null || text === undefined) {
      try {
        text = store.getItem(FILE_PREFIX + name);
      } catch (e) {
        text = null;
      }
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      log("warn", "данные " + name + " испорчены: " + (e && e.message));
      return null;
    }
  }

  /** Сохраняет JSON; возвращает, куда записано: "file", "localStorage" или "none". */
  async function writeJson(name, data) {
    var text = JSON.stringify(data);
    if (fileStore) {
      try {
        await fileStore.write(name, text);
        return "file";
      } catch (e) {
        log("warn", "файл " + name + " не записан, сохраняю в localStorage: " + (e && e.message));
      }
    }
    try {
      store.setItem(FILE_PREFIX + name, text);
      return "localStorage";
    } catch (e) {
      log("warn", "данные " + name + " не сохранены: " + (e && e.message));
      return "none";
    }
  }

  return { load: load, save: save, readJson: readJson, writeJson: writeJson };
}

module.exports = { createStorage: createStorage };
