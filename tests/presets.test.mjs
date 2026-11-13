import test from "node:test";
import assert from "node:assert/strict";
import { addPreset, fitProfile, normalizeProfile, removePreset, sanitizePresets } from "../webview-src/scene/presets.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sharp = (r, y) => ({ r, y, smooth: false });
const smooth = (r, y) => ({ r, y, smooth: true });
const BOTTLE = [sharp(100, -200), smooth(100, 50), smooth(40, 150), sharp(40, 200)];

test("пресет хранит пропорции контура, а не пиксели", () => {
  const twiceAsBigAndShifted = BOTTLE.map((p) => ({ ...p, r: p.r * 2, y: p.y * 2 + 500 }));
  const a = normalizeProfile(BOTTLE);
  const b = normalizeProfile(twiceAsBigAndShifted);
  assert.equal(a.length, 4);
  a.forEach((p, i) => {
    assert.ok(near(p.r, b[i].r) && near(p.y, b[i].y), `точка ${i}`);
    assert.equal(p.smooth, b[i].smooth);
  });
  assert.ok(near(a[0].y, 0) && near(a[3].y, 1), "высота приведена к 0…1");
  assert.ok(near(a[0].r, 0.25), "радиус — в долях высоты");
});

test("пресет подгоняется под высоту и положение текущего контура", () => {
  const points = fitProfile(normalizeProfile(BOTTLE), { minY: -350, maxY: 350 });
  assert.ok(near(points[0].y, -350) && near(points[3].y, 350));
  assert.ok(near(points[0].r, 175), `радиус растёт вместе с высотой: ${points[0].r}`);
  assert.deepEqual(points.map((p) => p.smooth), [false, true, true, false]);
});

test("нормализация и подгонка к тем же границам возвращают исходный контур", () => {
  const back = fitProfile(normalizeProfile(BOTTLE), { minY: -200, maxY: 200 });
  back.forEach((p, i) => assert.ok(near(p.r, BOTTLE[i].r, 1e-9) && near(p.y, BOTTLE[i].y, 1e-9), `точка ${i}`));
});

test("addPreset добавляет пресет с названием и нормализованным контуром", () => {
  const list = addPreset([], "  Бутылка вина ", BOTTLE, "Контур");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Бутылка вина");
  assert.ok(typeof list[0].id === "string" && list[0].id.length > 0);
  assert.deepEqual(list[0].points, normalizeProfile(BOTTLE));
});

test("addPreset без названия даёт имя по порядку", () => {
  let list = addPreset([], "", BOTTLE, "Контур");
  list = addPreset(list, "   ", BOTTLE, "Контур");
  assert.deepEqual(list.map((p) => p.name), ["Контур 1", "Контур 2"]);
  assert.notEqual(list[0].id, list[1].id);
});

test("addPreset с уже существующим названием заменяет пресет, а не плодит дубли", () => {
  let list = addPreset([], "Бутылка", BOTTLE, "Контур");
  const id = list[0].id;
  const other = [sharp(50, 0), sharp(50, 100)];
  list = addPreset(list, "Бутылка", other, "Контур");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.deepEqual(list[0].points, normalizeProfile(other));
});

test("addPreset не меняет исходный список", () => {
  const list = [];
  addPreset(list, "А", BOTTLE, "Контур");
  assert.equal(list.length, 0);
});

test("removePreset удаляет пресет по идентификатору", () => {
  let list = addPreset([], "А", BOTTLE, "Контур");
  list = addPreset(list, "Б", BOTTLE, "Контур");
  const rest = removePreset(list, list[0].id);
  assert.deepEqual(rest.map((p) => p.name), ["Б"]);
  assert.equal(list.length, 2);
});

test("sanitizePresets отбрасывает испорченные записи из файла", () => {
  const good = addPreset([], "А", BOTTLE, "Контур")[0];
  const cleaned = sanitizePresets([
    good,
    null,
    { id: "x", name: "без точек" },
    { id: "y", name: "одна точка", points: [{ r: 1, y: 0, smooth: true }] },
    { id: "z", name: "нечисла", points: [{ r: "a", y: 0 }, { r: 1, y: NaN }] },
    "строка",
  ]);
  assert.deepEqual(cleaned, [good]);
  assert.deepEqual(sanitizePresets("мусор"), []);
  assert.deepEqual(sanitizePresets(undefined), []);
});
