import test from "node:test";
import assert from "node:assert/strict";
import {
  FIELDS,
  applyDrag,
  applyScale,
  cameraSetup,
  clampField,
  cloneParams,
  defaultParams,
  resolvePlacement,
  sanitizeParams,
  setShapeType,
  shapeMatrix,
  shapeProfile,
  syncLinked,
} from "../webview-src/scene/params.js";
import { profileLength, radiusAt } from "../webview-src/scene/revolve.js";

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const LABEL = { left: 350, top: 470, width: 900, height: 260 };

/** Применяет матрицу 4×4 (по столбцам) к точке. */
function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
const nearPoint = (a, b) => a.every((v, i) => near(v, b[i]));

// ---------- значения по умолчанию ----------

test("по умолчанию: цилиндр, надпись без искажения, форма в центре надписи", () => {
  const params = defaultParams(LABEL);
  assert.equal(params.shape.type, "cylinder");
  assert.ok(near(params.shape.radius * 120 * DEG, 900), `радиус ${params.shape.radius}`);
  assert.equal(params.shape.height, 520, "форма вдвое выше надписи");
  assert.deepEqual(params.transform, { x: 800, y: 600, scale: 100, tilt: 0, roll: 0 });
  assert.deepEqual(params.placement, { offset: 0, rotation: 0, scale: 100, wrapAngle: 120, linked: true, hideBack: true });
  assert.deepEqual(params.camera, { type: "ortho", fov: 30 });
  assert.deepEqual(params.light, { shading: false, strength: 50 }, "по умолчанию без затенения");
});

// ---------- размещение надписи ----------

test("resolvePlacement по умолчанию: надпись в середине формы, лицом к камере", () => {
  const params = defaultParams(LABEL);
  const o = resolvePlacement(params, LABEL);
  assert.equal(o.thetaCenter, 0);
  assert.ok(near(o.thetaSpan, 120 * DEG));
  assert.equal(o.sLength, 260);
  assert.equal(o.sCenter, 260);
  assert.ok(o.thetaSegments >= 32);
  assert.deepEqual(o.profile, shapeProfile(params.shape));
});

test("resolvePlacement учитывает положение по высоте, поворот и масштаб", () => {
  const params = defaultParams(LABEL);
  params.placement.linked = false;
  params.placement.offset = 50;
  params.placement.rotation = 30;
  params.placement.scale = 50;
  params.placement.wrapAngle = 90;
  const o = resolvePlacement(params, LABEL);
  assert.equal(o.sCenter, 310, "выше середины на 50");
  assert.ok(near(o.thetaCenter, 30 * DEG));
  assert.equal(o.sLength, 130);
  assert.ok(near(o.thetaSpan, 90 * DEG));
});

test("с сохранением пропорций масштаб надписи меняет угол охвата", () => {
  const params = defaultParams(LABEL);
  params.placement.scale = 200;
  syncLinked(params, LABEL, "scale");
  assert.ok(near(params.placement.wrapAngle, 240));
});

test("с сохранением пропорций угол охвата меняет масштаб надписи", () => {
  const params = defaultParams(LABEL);
  params.placement.wrapAngle = 60;
  syncLinked(params, LABEL, "wrapAngle");
  assert.ok(near(params.placement.scale, 50));
});

test("с сохранением пропорций на форме большего радиуса надпись занимает меньший угол", () => {
  const params = defaultParams(LABEL);
  params.shape.radius *= 2;
  syncLinked(params, LABEL, "shape");
  assert.ok(near(params.placement.wrapAngle, 60));
  assert.equal(params.placement.scale, 100, "размер надписи не меняется");
});

test("без сохранения пропорций масштаб и угол охвата независимы", () => {
  const params = defaultParams(LABEL);
  params.placement.linked = false;
  params.placement.scale = 200;
  syncLinked(params, LABEL, "scale");
  assert.equal(params.placement.wrapAngle, 120);
});

test("на конусе надпись ближе к узкому краю занимает больший угол", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "cone", LABEL);
  const atMiddle = params.placement.wrapAngle;
  params.placement.offset = 100; // вверх, к узкому краю
  syncLinked(params, LABEL, "offset");
  assert.ok(params.placement.wrapAngle > atMiddle, `${params.placement.wrapAngle} > ${atMiddle}`);
});

test("угол охвата не превышает полного оборота", () => {
  const params = defaultParams(LABEL);
  params.placement.scale = 1000;
  syncLinked(params, LABEL, "scale");
  assert.equal(params.placement.wrapAngle, 360);
});

// ---------- формы ----------

test("shapeProfile строит образующую для каждой формы", () => {
  const params = defaultParams(LABEL);
  const r = params.shape.radius;
  assert.deepEqual(shapeProfile({ type: "cylinder", radius: 100, height: 50 }), [
    { r: 100, y: -25 },
    { r: 100, y: 25 },
  ]);
  assert.deepEqual(shapeProfile({ type: "cone", radiusBottom: 100, radiusTop: 60, height: 50 }), [
    { r: 100, y: -25 },
    { r: 60, y: 25 },
  ]);
  const sphere = shapeProfile({ type: "sphere", radius: r });
  assert.ok(sphere.length > 32);
  assert.ok(near(profileLength(sphere), Math.PI * r, r * 0.001));
});

test("переход к сфере сохраняет радиус", () => {
  const params = defaultParams(LABEL);
  const r = params.shape.radius;
  setShapeType(params, "sphere", LABEL);
  assert.equal(params.shape.type, "sphere");
  assert.equal(params.shape.radius, r);
});

test("переход к конусу берёт радиус цилиндра как нижний, верхний делает уже", () => {
  const params = defaultParams(LABEL);
  const r = params.shape.radius;
  setShapeType(params, "cone", LABEL);
  assert.equal(params.shape.type, "cone");
  assert.equal(params.shape.radiusBottom, r);
  assert.ok(near(params.shape.radiusTop, r * 0.7));
});

test("возврат от конуса к цилиндру берёт больший из радиусов", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "cone", LABEL);
  params.shape.radiusTop = 300;
  params.shape.radiusBottom = 500;
  setShapeType(params, "cylinder", LABEL);
  assert.equal(params.shape.radius, 500);
});

test("смена формы сохраняет размер надписи и пересчитывает угол охвата", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "cone", LABEL); // в середине конуса радиус 0.85 от цилиндра
  assert.equal(params.placement.scale, 100);
  assert.ok(near(params.placement.wrapAngle, 120 / 0.85, 0.01), `угол ${params.placement.wrapAngle}`);
});

// ---------- тело вращения ----------

/** Точка образующей на расстоянии s от её начала. */
function pointAt(profile, s) {
  let start = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const len = Math.hypot(profile[i + 1].r - profile[i].r, profile[i + 1].y - profile[i].y);
    if (s <= start + len + 1e-9) {
      const t = len > 0 ? (s - start) / len : 0;
      return { r: profile[i].r + (profile[i + 1].r - profile[i].r) * t, y: profile[i].y + (profile[i + 1].y - profile[i].y) * t };
    }
    start += len;
  }
  return profile[profile.length - 1];
}

test("переход к телу вращения создаёт контур и не сдвигает надпись", () => {
  const params = defaultParams(LABEL);
  const r = params.shape.radius;
  setShapeType(params, "lathe", LABEL);
  assert.equal(params.shape.type, "lathe");
  assert.ok(Array.isArray(params.shape.points) && params.shape.points.length >= 3);
  const o = resolvePlacement(params, LABEL);
  const at = pointAt(o.profile, o.sCenter);
  assert.ok(near(at.y, 0, 0.01), `надпись осталась на высоте центра: ${at.y}`);
  assert.ok(near(at.r, r, 0.01), `и на прежнем радиусе: ${at.r}`);
  assert.ok(near(params.placement.wrapAngle, 120, 0.01));
});

test("на теле вращения правка контура выше надписи её не сдвигает", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "lathe", LABEL);
  params.placement.offset = -40;
  const before = pointAt(resolvePlacement(params, LABEL).profile, resolvePlacement(params, LABEL).sCenter);
  const last = params.shape.points.length - 1;
  params.shape.points[last] = { ...params.shape.points[last], y: params.shape.points[last].y + 300 };
  const o = resolvePlacement(params, LABEL);
  const after = pointAt(o.profile, o.sCenter);
  assert.ok(near(after.y, before.y, 0.01) && near(after.r, before.r, 0.01), JSON.stringify({ before, after }));
});

test("положение по высоте отсчитывается по вертикали формы", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "cone", LABEL);
  params.placement.offset = 100;
  const o = resolvePlacement(params, LABEL);
  assert.ok(near(pointAt(o.profile, o.sCenter).y, 100, 0.01));
});

test("возврат к телу вращения сохраняет нарисованный контур", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "lathe", LABEL);
  params.shape.points = [
    { r: 200, y: -300, smooth: false },
    { r: 250, y: 0, smooth: true },
    { r: 90, y: 300, smooth: false },
  ];
  const drawn = JSON.stringify(params.shape.points);
  setShapeType(params, "cylinder", LABEL);
  assert.ok(near(params.shape.radius, 250, 0.5), `радиус цилиндра — по контуру у надписи: ${params.shape.radius}`);
  assert.equal(params.shape.height, 600, "высота — по контуру");
  setShapeType(params, "lathe", LABEL);
  assert.equal(JSON.stringify(params.shape.points), drawn);
});

test("cloneParams копирует параметры вместе с точками контура", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "lathe", LABEL);
  const copy = cloneParams(params);
  copy.shape.points[0].r = 1;
  copy.transform.x = -5;
  assert.notEqual(params.shape.points[0].r, 1);
  assert.notEqual(params.transform.x, -5);
  assert.deepEqual(cloneParams(params), params);
});

test("перетаскивание надписи на теле вращения не портит контур", () => {
  const start = defaultParams(LABEL);
  setShapeType(start, "lathe", LABEL);
  const next = applyDrag("label", start, { dxDoc: 10, dyDoc: -10, dxCss: 0, dyCss: 0 }, LABEL);
  assert.deepEqual(next.shape.points, start.shape.points);
  assert.notEqual(next.shape.points, start.shape.points, "у новых параметров свой массив точек");
});

// ---------- положение формы ----------

test("shapeMatrix ставит центр формы в точку документа (ось Y документа направлена вниз)", () => {
  const m = shapeMatrix({ x: 10, y: 20, scale: 100, tilt: 0, roll: 0 });
  assert.ok(nearPoint(transformPoint(m, [0, 0, 0]), [10, -20, 0]));
  assert.ok(nearPoint(transformPoint(m, [1, 2, 3]), [11, -18, 3]));
});

test("shapeMatrix: масштаб 200 % удваивает форму", () => {
  const m = shapeMatrix({ x: 0, y: 0, scale: 200, tilt: 0, roll: 0 });
  assert.ok(nearPoint(transformPoint(m, [1, 2, 3]), [2, 4, 6]));
});

test("shapeMatrix: положительный наклон к себе приближает верх формы к зрителю", () => {
  const m = shapeMatrix({ x: 0, y: 0, scale: 100, tilt: 90, roll: 0 });
  assert.ok(nearPoint(transformPoint(m, [0, 1, 0]), [0, 0, 1]));
});

test("shapeMatrix: положительный наклон вбок валит верх формы вправо", () => {
  const m = shapeMatrix({ x: 0, y: 0, scale: 100, tilt: 0, roll: 90 });
  assert.ok(nearPoint(transformPoint(m, [0, 1, 0]), [1, 0, 0]));
});

test("shapeMatrix: наклон вбок применяется после наклона к себе (в плоскости картинки)", () => {
  const m = shapeMatrix({ x: 0, y: 0, scale: 100, tilt: 90, roll: 90 });
  // верх формы после наклона к себе смотрит на зрителя — поворот в плоскости картинки его не сдвигает
  assert.ok(nearPoint(transformPoint(m, [0, 1, 0]), [0, 0, 1]));
});

// ---------- камера ----------

test("ортогональная камера: документ целиком в кадре, форма не обрезается по глубине", () => {
  const c = cameraSetup({ width: 1600, height: 1200 }, { type: "ortho", fov: 30 });
  assert.equal(c.type, "ortho");
  assert.ok(c.near < c.distance - 5000 && c.far > c.distance + 5000);
});

test("перспективная камера стоит так, что плоскость документа занимает кадр целиком", () => {
  const c = cameraSetup({ width: 1600, height: 1000 }, { type: "persp", fov: 90 });
  assert.equal(c.type, "persp");
  assert.equal(c.fov, 90);
  assert.ok(near(c.distance, 500), `расстояние ${c.distance}`);
  assert.ok(c.near > 0 && c.near < c.distance && c.far > c.distance * 2);
});

// ---------- управление мышью ----------

test("перетаскивание в режиме «Форма» двигает форму по документу", () => {
  const start = defaultParams(LABEL);
  const next = applyDrag("form", start, { dxDoc: 30, dyDoc: -40, dxCss: 3, dyCss: -4 }, LABEL);
  assert.equal(next.transform.x, 830);
  assert.equal(next.transform.y, 560);
  assert.equal(start.transform.x, 800, "исходные параметры не меняются");
});

test("перетаскивание в режиме «Надпись» вращает надпись так, что она идёт за курсором", () => {
  const start = defaultParams(LABEL);
  const r = start.shape.radius;
  // сдвиг на длину дуги в 10° по поверхности
  const next = applyDrag("label", start, { dxDoc: r * 10 * DEG, dyDoc: 0, dxCss: 0, dyCss: 0 }, LABEL);
  assert.ok(near(next.placement.rotation, 10));
});

test("перетаскивание в режиме «Надпись» вверх поднимает надпись по форме", () => {
  const start = defaultParams(LABEL);
  const next = applyDrag("label", start, { dxDoc: 0, dyDoc: -25, dxCss: 0, dyCss: 0 }, LABEL);
  assert.equal(next.placement.offset, 25);
});

test("перетаскивание надписи учитывает масштаб формы", () => {
  const start = defaultParams(LABEL);
  start.transform.scale = 200;
  const next = applyDrag("label", start, { dxDoc: 0, dyDoc: -50, dxCss: 0, dyCss: 0 }, LABEL);
  assert.equal(next.placement.offset, 25);
});

test("перетаскивание в режиме «Наклон» меняет наклон вбок и к себе", () => {
  const start = defaultParams(LABEL);
  const next = applyDrag("tilt", start, { dxDoc: 0, dyDoc: 0, dxCss: 40, dyCss: 20 }, LABEL);
  assert.ok(next.transform.roll > 0 && next.transform.tilt > 0);
  assert.ok(near(next.transform.roll, 10) && near(next.transform.tilt, 5));
});

test("наклон к себе ограничен, чтобы форма не переворачивалась", () => {
  const start = defaultParams(LABEL);
  const next = applyDrag("tilt", start, { dxDoc: 0, dyDoc: 0, dxCss: 0, dyCss: 5000 }, LABEL);
  assert.equal(next.transform.tilt, FIELDS["transform.tilt"].max);
});

test("applyScale в режиме «Форма» масштабирует форму, в режиме «Надпись» — надпись с углом охвата", () => {
  const start = defaultParams(LABEL);
  const form = applyScale("form", start, 1.5, LABEL);
  assert.ok(near(form.transform.scale, 150));
  assert.equal(form.placement.scale, 100);
  const label = applyScale("label", start, 0.5, LABEL);
  assert.ok(near(label.placement.scale, 50));
  assert.ok(near(label.placement.wrapAngle, 60));
  assert.equal(label.transform.scale, 100);
});

// ---------- границы полей ----------

test("clampField ограничивает значение границами поля", () => {
  assert.equal(clampField("camera.fov", 500), FIELDS["camera.fov"].max);
  assert.equal(clampField("camera.fov", -3), FIELDS["camera.fov"].min);
  assert.equal(clampField("shape.radius", 0), FIELDS["shape.radius"].min);
});

test("clampField заворачивает поворот вокруг оси в диапазон −180…180", () => {
  assert.equal(clampField("placement.rotation", 190), -170);
  assert.equal(clampField("placement.rotation", -270), 90);
  assert.equal(clampField("placement.rotation", 45), 45);
});

test("clampField возвращает null для нечисла", () => {
  assert.equal(clampField("shape.radius", NaN), null);
  assert.equal(clampField("shape.radius", "abc"), null);
});

// ---------- восстановление сохранённой сцены ----------

test("sanitizeParams возвращает сохранённые параметры без изменений, если они в порядке", () => {
  const params = defaultParams(LABEL);
  setShapeType(params, "lathe", LABEL);
  params.light.shading = true;
  params.transform.tilt = 12;
  const restored = sanitizeParams(JSON.parse(JSON.stringify(params)));
  assert.deepEqual(restored, params);
});

test("sanitizeParams отвергает мусор", () => {
  assert.equal(sanitizeParams(null), null);
  assert.equal(sanitizeParams("строка"), null);
  assert.equal(sanitizeParams({}), null);
  assert.equal(sanitizeParams({ shape: {}, transform: {}, placement: {}, camera: {} }), null, "без формы и размеров");
});

test("sanitizeParams ограничивает числа и чинит недостающие поля", () => {
  const saved = JSON.parse(JSON.stringify(defaultParams(LABEL)));
  saved.camera.fov = 500;
  saved.camera.type = "fisheye";
  saved.transform.tilt = "abc";
  delete saved.light; // сцена, сохранённая до появления затенения
  delete saved.placement.hideBack;
  const restored = sanitizeParams(saved);
  assert.equal(restored.camera.fov, FIELDS["camera.fov"].max);
  assert.equal(restored.camera.type, "ortho");
  assert.equal(restored.transform.tilt, 0);
  assert.deepEqual(restored.light, { shading: false, strength: 50 });
  assert.equal(restored.placement.hideBack, true);
});

test("sanitizeParams не оставляет тело вращения без контура", () => {
  const saved = JSON.parse(JSON.stringify(defaultParams(LABEL)));
  saved.shape.type = "lathe";
  saved.shape.points = [{ r: 10, y: 0, smooth: true }];
  assert.equal(sanitizeParams(saved).shape.type, "cylinder");
  saved.shape.type = "пирамида";
  assert.equal(sanitizeParams(saved).shape.type, "cylinder");
});

test("cloneParams копирует освещение", () => {
  const params = defaultParams(LABEL);
  const copy = cloneParams(params);
  copy.light.shading = true;
  assert.equal(params.light.shading, false);
});
