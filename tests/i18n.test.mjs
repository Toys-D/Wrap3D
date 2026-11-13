import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasKey, setLang, t } from "../webview-src/ui/i18n.js";
import { formatNumber } from "../webview-src/ui/controls.js";

const root = path.resolve(import.meta.dirname, "..");

/** Все ключи строк, на которые ссылаются разметка и код интерфейса. */
function usedKeys() {
  const keys = new Set();
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const collect = (text, pattern) => {
    for (const m of text.matchAll(pattern)) keys.add(m[1]);
  };
  // разметка: data-i18n="ключ"
  collect(read("plugin/webview/index.html"), /data-i18n="([\w.]+)"/g);
  // описание полей: label: "ключ", title: "ключ" и вторые элементы пар ["значение", "ключ"]
  const controls = read("webview-src/ui/controls.js");
  collect(controls, /(?:label|title): "([\w.]+)"/g);
  collect(controls, /\["\w+", "([\w.]+)"\]/g);
  collect(controls, /"(hint\.[\w.]+)"/g);
  // код: t("ключ") и setStatus("ключ")
  const main = read("webview-src/main.js");
  collect(main, /\bt\("([\w.]+)"/g);
  collect(main, /setStatus\("([\w.]+)"/g);
  // панель пресетов: ключи текста, подсказок и заглушек
  const presets = read("webview-src/ui/presets-panel.js");
  collect(presets, /"((?:preset)\.[\w.]+)"/g);
  for (const mode of ["form", "label", "tilt", "contour", "view"]) keys.add("mouse." + mode);
  // ключи, которые собираются из частей ("mouse." + режим), перечислены выше явно
  return [...keys].filter((key) => !key.endsWith("."));
}

test("у каждой строки интерфейса есть русский и английский текст", () => {
  const keys = usedKeys();
  assert.ok(keys.length > 40, "ключи найдены: " + keys.length);
  for (const lang of ["ru", "en"]) {
    setLang(lang);
    const missing = keys.filter((key) => !hasKey(key));
    assert.deepEqual(missing, [], "нет перевода (" + lang + ")");
  }
});

test("подсказка о перетаскивании значений мышью есть в панели параметров", () => {
  const keys = usedKeys();
  assert.ok(keys.includes("hint.scrub"), "всплывающая подсказка у поля");
  assert.ok(keys.includes("hint.scrubLine"), "строка-подсказка над параметрами");
});

test("русские и английские строки различаются там, где это слова, а не обозначения", () => {
  setLang("ru");
  const ru = t("btn.apply");
  setLang("en");
  assert.notEqual(t("btn.apply"), ru);
});

test("t подставляет значения и не падает на неизвестном ключе", () => {
  setLang("ru");
  assert.equal(t("status.loaded", { ms: 42 }), "Слой загружен за 42 мс");
  assert.equal(t("нет.такого.ключа"), "нет.такого.ключа");
});

test("formatNumber показывает один знак после запятой без хвостовых нулей", () => {
  assert.equal(formatNumber(430.6732), "430.7");
  assert.equal(formatNumber(120), "120");
  assert.equal(formatNumber(-0.04), "0");
  assert.equal(formatNumber(NaN), "");
});
