import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW_PREFS, formAppearance, sanitizeViewPrefs } from "../webview-src/scene/appearance.js";
import { FIELDS, clampField } from "../webview-src/scene/params.js";

test("по умолчанию форма показывается как раньше — подсветкой краёв", () => {
  assert.equal(DEFAULT_VIEW_PREFS.formStyle, "rim");
  assert.equal(DEFAULT_VIEW_PREFS.formOpacity, 40);
  const a = formAppearance(DEFAULT_VIEW_PREFS);
  assert.equal(a.solid, false);
  assert.equal(a.doubleSided, true);
  assert.equal(a.ringOpacity, 0.95);
});

test("в режиме краёв ползунок непрозрачности на вид формы не влияет", () => {
  assert.deepEqual(formAppearance({ formStyle: "rim", formOpacity: 0 }), formAppearance({ formStyle: "rim", formOpacity: 100 }));
});

test("сплошная форма: непрозрачность заливки равна значению ползунка", () => {
  assert.equal(formAppearance({ formStyle: "solid", formOpacity: 0 }).alpha, 0);
  assert.equal(formAppearance({ formStyle: "solid", formOpacity: 40 }).alpha, 0.4);
  assert.equal(formAppearance({ formStyle: "solid", formOpacity: 100 }).alpha, 1);
});

test("сплошная форма рисуется одним слоем, иначе прозрачность задней стенки складывалась бы с передней", () => {
  const a = formAppearance({ formStyle: "solid", formOpacity: 40 });
  assert.equal(a.solid, true);
  assert.equal(a.doubleSided, false);
});

test("при нулевой непрозрачности сплошная форма исчезает целиком, вместе с линиями краёв", () => {
  assert.equal(formAppearance({ formStyle: "solid", formOpacity: 0 }).ringOpacity, 0);
  assert.ok(formAppearance({ formStyle: "solid", formOpacity: 10 }).ringOpacity > 0);
  assert.ok(formAppearance({ formStyle: "solid", formOpacity: 100 }).ringOpacity <= 1);
});

test("по умолчанию исходный слой на фоне не показывается", () => {
  assert.equal(DEFAULT_VIEW_PREFS.showSource, false);
});

test("sanitizeViewPrefs принимает сохранённые настройки и чинит испорченные", () => {
  assert.deepEqual(sanitizeViewPrefs({ formStyle: "solid", formOpacity: 75, showSource: true }), {
    formStyle: "solid",
    formOpacity: 75,
    showSource: true,
  });
  assert.deepEqual(sanitizeViewPrefs({ formStyle: "неон", formOpacity: 250, showSource: "да" }), {
    formStyle: "rim",
    formOpacity: 100,
    showSource: false,
  });
  assert.deepEqual(sanitizeViewPrefs({ formOpacity: "abc" }), DEFAULT_VIEW_PREFS);
  assert.deepEqual(sanitizeViewPrefs(null), DEFAULT_VIEW_PREFS);
  assert.deepEqual(sanitizeViewPrefs({ lang: "en" }), DEFAULT_VIEW_PREFS, "чужие настройки не мешают");
});

test("поле непрозрачности формы ограничено 0…100 %", () => {
  assert.deepEqual({ min: FIELDS["ui.formOpacity"].min, max: FIELDS["ui.formOpacity"].max }, { min: 0, max: 100 });
  assert.equal(clampField("ui.formOpacity", 140), 100);
  assert.equal(clampField("ui.formOpacity", -5), 0);
});
