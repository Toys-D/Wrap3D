import test from "node:test";
import assert from "node:assert/strict";
import { fitView, panView, resizeView, viewToDoc, zoomView } from "../webview-src/scene/view.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const DOC = { width: 1600, height: 1200 };

test("fitView показывает документ целиком и по центру", () => {
  const v = fitView(DOC, 800, 800);
  assert.ok(v.x < 0 && v.y < 0, "вокруг документа есть поля");
  assert.ok(v.x + v.w > DOC.width && v.y + v.h > DOC.height);
  assert.ok(near(v.x + v.w / 2, 800) && near(v.y + v.h / 2, 600), "центр документа в центре вида");
  assert.ok(near(v.w * v.scale, 800) && near(v.h * v.scale, 800), "вид занимает всё окно");
});

test("viewToDoc переводит точку окна в точку документа", () => {
  const v = { x: 100, y: 50, w: 400, h: 300, scale: 2 };
  assert.deepEqual(viewToDoc(v, 0, 0), { x: 100, y: 50 });
  assert.deepEqual(viewToDoc(v, 200, 100), { x: 200, y: 100 });
});

test("zoomView оставляет точку документа под курсором на месте", () => {
  const v = fitView(DOC, 800, 600);
  const before = viewToDoc(v, 250, 420);
  const z = zoomView(v, 2.5, 250, 420);
  const after = viewToDoc(z, 250, 420);
  assert.ok(near(z.scale, v.scale * 2.5));
  assert.ok(near(before.x, after.x) && near(before.y, after.y));
  assert.ok(near(z.w * z.scale, 800) && near(z.h * z.scale, 600), "размер окна тот же");
});

test("zoomView не уходит за пределы допустимого масштаба", () => {
  const v = fitView(DOC, 800, 600);
  assert.ok(zoomView(v, 1e9, 400, 300).scale <= 64);
  assert.ok(zoomView(v, 1e-9, 400, 300).scale >= v.scale * 1e-9);
  assert.ok(zoomView(v, 1e-9, 400, 300).scale >= 0.005);
});

test("panView сдвигает вид вслед за курсором", () => {
  const v = { x: 100, y: 50, w: 400, h: 300, scale: 2 };
  const p = panView(v, 20, -10);
  assert.equal(p.x, 90);
  assert.equal(p.y, 55);
  assert.equal(p.scale, 2);
});

test("resizeView при изменении окна сохраняет масштаб и центр вида", () => {
  const v = { x: 100, y: 50, w: 400, h: 300, scale: 2 };
  const r = resizeView(v, 1000, 400);
  assert.equal(r.scale, 2);
  assert.equal(r.w, 500);
  assert.equal(r.h, 200);
  assert.ok(near(r.x + r.w / 2, 300) && near(r.y + r.h / 2, 200));
});
