import test from "node:test";
import assert from "node:assert/strict";
import { prepareTexture, unpremultiply, cropToAlpha, blitFlipped, toRGBA } from "../webview-src/scene/pixels.js";

test("prepareTexture умножает цвет на альфу и добавляет прозрачную рамку", () => {
  // 2×1: полупрозрачный и непрозрачный пиксели
  const src = new Uint8Array([200, 100, 50, 128, 10, 20, 30, 255]);
  const tex = prepareTexture(src, 2, 1, 4, 1);
  assert.equal(tex.width, 4);
  assert.equal(tex.height, 3);
  assert.equal(tex.pad, 1);
  const px = (x, y) => Array.from(tex.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(px(1, 1), [100, 50, 25, 128]);
  assert.deepEqual(px(2, 1), [10, 20, 30, 255]);
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]]) {
    assert.deepEqual(px(x, y), [0, 0, 0, 0], `рамка (${x},${y})`);
  }
});

test("prepareTexture считает слой без альфа-канала полностью непрозрачным", () => {
  const src = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const tex = prepareTexture(src, 2, 1, 3, 0);
  assert.deepEqual(Array.from(tex.pixels), [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("prepareTexture считает пиксели, где цвет ярче альфы (признак неумноженной альфы)", () => {
  const src = new Uint8Array([200, 100, 50, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  const tex = prepareTexture(src, 3, 1, 4, 0);
  assert.equal(tex.straightEvidence, 1);
});

test("prepareTexture не меняет исходный массив", () => {
  const src = new Uint8Array([200, 100, 50, 128]);
  prepareTexture(src, 1, 1, 4, 1);
  assert.deepEqual(Array.from(src), [200, 100, 50, 128]);
});

test("unpremultiply возвращает цвет, не трогает непрозрачные и обнуляет пустые пиксели", () => {
  const buf = new Uint8Array([
    100, 50, 25, 128, // полупрозрачный
    10, 20, 30, 255, // непрозрачный — без изменений
    7, 7, 7, 0, // пустой
    200, 0, 0, 100, // цвет больше альфы — ограничить 255
  ]);
  unpremultiply(buf);
  assert.deepEqual(Array.from(buf), [199, 100, 50, 128, 10, 20, 30, 255, 0, 0, 0, 0, 255, 0, 0, 100]);
});

test("cropToAlpha обрезает до области с непрозрачными пикселями", () => {
  const w = 5;
  const h = 4;
  const buf = new Uint8Array(w * h * 4);
  const set = (x, y, v) => buf.set([v, v, v, 255], (y * w + x) * 4);
  set(1, 1, 10);
  set(3, 2, 20);
  const out = cropToAlpha(buf, w, h);
  assert.deepEqual({ left: out.left, top: out.top, width: out.width, height: out.height }, { left: 1, top: 1, width: 3, height: 2 });
  assert.deepEqual(Array.from(out.pixels.subarray(0, 4)), [10, 10, 10, 255]);
  assert.deepEqual(Array.from(out.pixels.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)), [20, 20, 20, 255]);
  assert.equal(out.pixels.length, 3 * 2 * 4);
});

test("cropToAlpha возвращает null для полностью прозрачного изображения", () => {
  assert.equal(cropToAlpha(new Uint8Array(4 * 4 * 4), 4, 4), null);
});

test("blitFlipped переворачивает строки плитки и кладёт её на место в общий буфер", () => {
  // плитка 2×2, строки снизу вверх (как отдаёт WebGL): нижняя [1,2], верхняя [3,4]
  const tile = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
  const dstW = 4;
  const dst = new Uint8Array(dstW * 3 * 4);
  blitFlipped(tile, 2, 2, dst, dstW, 1, 1);
  const px = (x, y) => dst[(y * dstW + x) * 4];
  assert.equal(px(1, 1), 3);
  assert.equal(px(2, 1), 4);
  assert.equal(px(1, 2), 1);
  assert.equal(px(2, 2), 2);
  assert.equal(px(0, 0), 0);
  assert.equal(px(3, 2), 0);
});

test("toRGBA дополняет RGB непрозрачной альфой", () => {
  const out = toRGBA(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1, 3);
  assert.deepEqual(Array.from(out), [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("toRGBA оставляет RGBA как есть", () => {
  const src = new Uint8Array([1, 2, 3, 40, 5, 6, 7, 80]);
  assert.deepEqual(Array.from(toRGBA(src, 2, 1, 4)), [1, 2, 3, 40, 5, 6, 7, 80]);
});
