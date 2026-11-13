import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProfile,
  docToLocal,
  hitPoint,
  insertPoint,
  localToDoc,
  movePoint,
  removePoint,
  sampleProfile,
  toggleSmooth,
} from "../webview-src/scene/profile.js";
import { radiusAt, sAtHeight } from "../webview-src/scene/revolve.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sharp = (r, y) => ({ r, y, smooth: false });
const smooth = (r, y) => ({ r, y, smooth: true });

/** Угол между направлением входа в точку ломаной и выхода из неё, градусы. */
function turnAngleAt(dense, r, y) {
  const i = dense.findIndex((p) => near(p.r, r, 1e-6) && near(p.y, y, 1e-6));
  assert.ok(i > 0 && i < dense.length - 1, "точка внутри ломаной");
  const a = [dense[i].r - dense[i - 1].r, dense[i].y - dense[i - 1].y];
  const b = [dense[i + 1].r - dense[i].r, dense[i + 1].y - dense[i].y];
  const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

// ---------- контур по умолчанию ----------

test("контур по умолчанию из цилиндра — бутылка, у которой на высоте центра тот же радиус", () => {
  const points = defaultProfile({ type: "cylinder", radius: 100, height: 400 });
  assert.ok(points.length >= 3);
  assert.equal(points[0].y, -200);
  assert.equal(points[points.length - 1].y, 200);
  const dense = sampleProfile(points);
  assert.ok(near(radiusAt(dense, sAtHeight(dense, 0)), 100), "надпись в центре останется на радиусе цилиндра");
  assert.ok(points[points.length - 1].r < 100, "горлышко уже тела");
});

test("контур по умолчанию из конуса повторяет конус", () => {
  assert.deepEqual(defaultProfile({ type: "cone", radiusBottom: 100, radiusTop: 60, height: 200 }), [
    sharp(100, -100),
    sharp(60, 100),
  ]);
});

// ---------- сглаживание ----------

test("между двумя острыми точками — прямая", () => {
  assert.deepEqual(sampleProfile([sharp(100, 0), sharp(60, 200)]), [
    { r: 100, y: 0 },
    { r: 60, y: 200 },
  ]);
});

test("кривая проходит через все опорные точки", () => {
  const points = [sharp(100, 0), smooth(120, 100), smooth(40, 180), sharp(40, 260)];
  const dense = sampleProfile(points);
  for (const p of points) {
    assert.ok(dense.some((d) => near(d.r, p.r) && near(d.y, p.y)), `точка ${p.r},${p.y}`);
  }
  assert.ok(dense.length > points.length, "между точками добавлены промежуточные");
});

test("в сглаженной точке контур не ломается, в острой — ломается", () => {
  const corner = sampleProfile([sharp(100, 0), sharp(100, 100), sharp(0, 100)]);
  assert.ok(near(turnAngleAt(corner, 100, 100), 90, 1e-6), "острый угол 90°");
  const rounded = sampleProfile([sharp(100, 0), smooth(100, 100), sharp(0, 100)]);
  assert.ok(turnAngleAt(rounded, 100, 100) < 20, `сглажено: ${turnAngleAt(rounded, 100, 100)}°`);
});

test("сглаженная кривая не уходит за ось вращения", () => {
  const dense = sampleProfile([sharp(60, 0), smooth(0, 50), sharp(60, 100)]);
  assert.ok(dense.every((p) => p.r >= 0));
});

test("sampleProfile выдаёт не меньше двух точек и не меняет исходные", () => {
  const points = [smooth(50, 0), smooth(80, 60)];
  const copy = JSON.stringify(points);
  assert.ok(sampleProfile(points).length >= 2);
  assert.equal(JSON.stringify(points), copy);
});

// ---------- координаты ----------

test("localToDoc: без наклона радиус откладывается вправо от оси, высота — вверх", () => {
  const t = { x: 100, y: 200, scale: 200, tilt: 0, roll: 0 };
  assert.deepEqual(localToDoc(t, 10, 20), { x: 120, y: 160 });
});

test("localToDoc: при наклоне вбок на 90° верх оси смотрит вправо", () => {
  const t = { x: 100, y: 200, scale: 100, tilt: 0, roll: 90 };
  const top = localToDoc(t, 0, 10);
  assert.ok(near(top.x, 110) && near(top.y, 200), JSON.stringify(top));
});

test("docToLocal обратна localToDoc", () => {
  const t = { x: 321, y: 123, scale: 150, tilt: 0, roll: 37 };
  const doc = localToDoc(t, 42, -17);
  const local = docToLocal(t, doc.x, doc.y);
  assert.ok(near(local.r, 42) && near(local.y, -17), JSON.stringify(local));
});

test("docToLocal: точка слева от оси даёт отрицательный радиус", () => {
  const t = { x: 100, y: 100, scale: 100, tilt: 0, roll: 0 };
  assert.ok(docToLocal(t, 60, 100).r < 0);
});

// ---------- правка точек ----------

test("insertPoint вставляет точку в ближайший отрезок контура", () => {
  const points = [sharp(100, 0), sharp(100, 200)];
  const res = insertPoint(points, 110, 90);
  assert.equal(res.index, 1);
  assert.deepEqual(res.points, [sharp(100, 0), smooth(110, 90), sharp(100, 200)]);
  assert.equal(points.length, 2, "исходный массив не меняется");
});

test("insertPoint за концом контура продолжает его", () => {
  const points = [sharp(100, 0), sharp(100, 200)];
  assert.equal(insertPoint(points, 60, 260).index, 2, "выше верхней точки — в конец");
  assert.equal(insertPoint(points, 60, -50).index, 0, "ниже нижней точки — в начало");
});

test("insertPoint слева от оси ставит точку на правой половине", () => {
  const res = insertPoint([sharp(100, 0), sharp(100, 200)], -80, 100);
  assert.equal(res.points[res.index].r, 80);
});

test("movePoint двигает точку и не пускает её за ось", () => {
  const points = [sharp(100, 0), sharp(100, 200)];
  const moved = movePoint(points, 1, -30, 150);
  assert.deepEqual(moved[1], sharp(0, 150));
  assert.deepEqual(points[1], sharp(100, 200), "исходная точка не меняется");
});

test("removePoint удаляет точку, но оставляет минимум две", () => {
  const three = [sharp(100, 0), smooth(120, 100), sharp(100, 200)];
  assert.deepEqual(removePoint(three, 1), [sharp(100, 0), sharp(100, 200)]);
  const two = [sharp(100, 0), sharp(100, 200)];
  assert.deepEqual(removePoint(two, 0), two);
});

test("toggleSmooth переключает точку между острой и сглаженной", () => {
  const points = [sharp(100, 0), smooth(120, 100)];
  assert.equal(toggleSmooth(points, 0)[0].smooth, true);
  assert.equal(toggleSmooth(points, 1)[1].smooth, false);
  assert.equal(points[0].smooth, false, "исходный массив не меняется");
});

test("hitPoint находит ближайшую точку в пределах допуска", () => {
  const points = [sharp(100, 0), smooth(120, 100), sharp(100, 200)];
  assert.equal(hitPoint(points, 118, 103, 6), 1);
  assert.equal(hitPoint(points, 150, 100, 6), -1);
  assert.equal(hitPoint(points, 101, 199, 6), 2);
});
