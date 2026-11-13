"use strict";
/*
 * Wrap 3D — работа с документом Photoshop.
 *
 * Модуль photoshop передаётся параметром (в main.js это require("photoshop")),
 * чтобы логику можно было проверить тестами без Photoshop.
 *
 * Используются только вызовы из документации Adobe:
 *   imaging.getPixels / createImageDataFromBuffer / putPixels,
 *   core.executeAsModal + hostControl.suspendHistory / resumeHistory,
 *   document.createPixelLayer.
 */

var HISTORY_NAME = "Wrap 3D";
var UNSUPPORTED_MODE = /cmyk|lab|gray|bitmap|indexed|duotone|multichannel/i;

function fail(code, message, detail) {
  var err = new Error(message || code);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function num(v) {
  if (typeof v === "number") return v;
  if (v && typeof v._value === "number") return v._value;
  if (v && typeof v.value === "number") return v.value;
  return Number(v);
}

/** Приводит границы Photoshop к { left, top, width, height }. */
function rectOf(b) {
  if (!b) return null;
  var left = num(b.left);
  var top = num(b.top);
  var right = b.right !== undefined ? num(b.right) : left + num(b.width);
  var bottom = b.bottom !== undefined ? num(b.bottom) : top + num(b.height);
  if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;
  return { left: left, top: top, width: right - left, height: bottom - top };
}

function createPhotoshopApi(ps, log) {
  log = log || function () {};

  /** executeAsModal с понятными кодами ошибок. */
  async function modal(fn, commandName) {
    var inner = null;
    try {
      return await ps.core.executeAsModal(
        async function (ctx) {
          try {
            return await fn(ctx);
          } catch (e) {
            inner = e;
            throw e;
          }
        },
        { commandName: commandName },
      );
    } catch (e) {
      var err = inner || e;
      if (err && err.code && typeof err.code === "string") throw err;
      if (err && err.number === 9) {
        throw fail("psBusy", String(err.message || "host is in a modal state"));
      }
      throw fail("psError", String((err && err.message) || err), { number: err && err.number });
    }
  }

  /** Ищет слой по номеру во всём дереве слоёв, включая группы. */
  function findLayer(layers, id) {
    var count = layers ? layers.length : 0;
    for (var i = 0; i < count; i++) {
      var layer = layers[i];
      if (layer.id === id) return layer;
      var inside = findLayer(layer.layers, id);
      if (inside) return inside;
    }
    return null;
  }

  /**
   * Читает пиксели слоя: единственного выделенного либо, если задан p.layerId, слоя с этим
   * номером (так восстанавливается сцена последнего применения).
   * p.expect — { docName, docWidth, docHeight }: если активен другой документ, ошибка docMismatch.
   * p.maxSize — предел стороны текстуры; слой крупнее уменьшается самим Photoshop.
   * Возвращает { info, pixels }: pixels — Uint8Array, строки сверху вниз,
   * info.components значений на пиксель (4 — RGBA, 3 — RGB).
   */
  async function readSelectedLayer(p) {
    var maxSize = (p && p.maxSize) || 8192;
    var doc = ps.app.activeDocument;
    if (!doc) throw fail("noDocument");

    var mode = String(doc.mode || "");
    if (UNSUPPORTED_MODE.test(mode)) throw fail("unsupportedMode", mode, { mode: mode });

    var expect = p && p.expect;
    if (expect) {
      var sameDoc =
        String(doc.name || "") === expect.docName && num(doc.width) === expect.docWidth && num(doc.height) === expect.docHeight;
      if (!sameDoc) throw fail("docMismatch");
    }

    var layer;
    if (p && p.layerId !== undefined && p.layerId !== null) {
      layer = findLayer(doc.layers, p.layerId);
      if (!layer) throw fail("layerGone");
    } else {
      var selected = doc.activeLayers;
      var count = selected ? selected.length : 0;
      if (count === 0) throw fail("noLayer");
      if (count > 1) throw fail("multiLayer");
      layer = selected[0];
    }

    var bounds = rectOf(layer.boundsNoEffects || layer.bounds);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) throw fail("emptyLayer");

    var options = { documentID: doc.id, layerID: layer.id, colorSpace: "RGB", componentSize: 8 };
    var scale = Math.min(1, maxSize / Math.max(bounds.width, bounds.height));
    var scaled = scale < 1;
    if (scaled) {
      options.sourceBounds = {
        left: bounds.left,
        top: bounds.top,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
      };
      options.targetSize = {
        width: Math.max(1, Math.round(bounds.width * scale)),
        height: Math.max(1, Math.round(bounds.height * scale)),
      };
    }

    var info = null;
    var pixels = null;
    var timings = {};
    await modal(async function () {
      var t0 = Date.now();
      var res = await ps.imaging.getPixels(options);
      timings.getPixels = Date.now() - t0;
      var image = res.imageData;
      try {
        var t1 = Date.now();
        var data = await image.getData({ chunky: true });
        // Копия: документация не говорит, остаются ли данные доступными после dispose().
        pixels = data.slice();
        timings.getData = Date.now() - t1;
        // При уменьшении sourceBounds относятся к уменьшенной копии (см. документацию),
        // поэтому положение берём из границ слоя.
        var rect = scaled ? bounds : rectOf(res.sourceBounds) || bounds;
        info = {
          docId: doc.id,
          docName: String(doc.name || ""),
          docWidth: num(doc.width),
          docHeight: num(doc.height),
          docMode: mode,
          layerId: layer.id,
          layerName: String(layer.name || ""),
          layerKind: String(layer.kind || ""),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          srcWidth: image.width,
          srcHeight: image.height,
          components: image.components,
          scaled: scaled,
          timings: timings,
        };
      } finally {
        image.dispose();
      }
    }, HISTORY_NAME);

    if (pixels.BYTES_PER_ELEMENT !== 1 || pixels.length !== info.srcWidth * info.srcHeight * info.components) {
      throw fail(
        "badData",
        "неожиданный формат пикселей: " + pixels.length + " значений на " + info.srcWidth + "×" + info.srcHeight + "×" + info.components,
      );
    }
    if (info.components !== 3 && info.components !== 4) {
      throw fail("badData", "неожиданное число каналов: " + info.components);
    }
    return { info: info, pixels: pixels };
  }

  /**
   * Снимок документа для фона во вьюпорте: сведённое изображение, уменьшенное так,
   * чтобы длинная сторона не превышала p.maxSize.
   *
   * p.hideLayerId — номер слоя, которого на снимке быть не должно (исходная надпись: она
   * мешает совмещать форму с фото). Слой скрывается только на время чтения: история на это
   * время приостановлена и затем откатывается (resumeHistory с commit = false), поэтому
   * документ не меняется и записи в истории не остаётся.
   *
   * Возвращает { info, pixels }: info.components значений на пиксель (3 — RGB, 4 — RGBA),
   * info.hiddenLayer — был ли слой скрыт на снимке.
   */
  async function readDocumentSnapshot(p) {
    var maxSize = (p && p.maxSize) || 2048;
    var doc = ps.app.activeDocument;
    if (!doc) throw fail("noDocument");

    var docWidth = num(doc.width);
    var docHeight = num(doc.height);
    // без layerID getPixels возвращает сведённое изображение документа
    var options = { documentID: doc.id, colorSpace: "RGB", componentSize: 8 };
    if (Math.max(docWidth, docHeight) > maxSize) {
      // достаточно одной стороны: вторую Photoshop считает пропорционально
      options.targetSize = docWidth >= docHeight ? { width: maxSize } : { height: maxSize };
    }

    // Скрывать нужно только слой, который сейчас виден.
    var layerToHide = null;
    if (p && p.hideLayerId !== undefined && p.hideLayerId !== null) {
      var found = findLayer(doc.layers, p.hideLayerId);
      if (found && found.visible) layerToHide = found;
    }

    var info = null;
    var pixels = null;
    var timings = {};
    await modal(async function (ctx) {
      var suspension = null;
      if (layerToHide) {
        suspension = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HISTORY_NAME });
        layerToHide.visible = false;
      }
      try {
        var t0 = Date.now();
        var res = await ps.imaging.getPixels(options);
        timings.getPixels = Date.now() - t0;
        var image = res.imageData;
        try {
          var t1 = Date.now();
          pixels = (await image.getData({ chunky: true })).slice();
          timings.getData = Date.now() - t1;
          info = {
            docId: doc.id,
            docWidth: docWidth,
            docHeight: docHeight,
            width: image.width,
            height: image.height,
            components: image.components,
            hiddenLayer: !!layerToHide,
            timings: timings,
          };
        } finally {
          image.dispose();
        }
      } finally {
        if (layerToHide) {
          // Видимость возвращается явно, а откат истории страхует и убирает запись.
          try {
            layerToHide.visible = true;
          } catch (e) {
            log("warn", "видимость слоя не возвращена напрямую: " + (e && e.message));
          }
          await ctx.hostControl.resumeHistory(suspension, false);
        }
      }
    }, HISTORY_NAME);

    if (pixels.BYTES_PER_ELEMENT !== 1 || pixels.length !== info.width * info.height * info.components) {
      throw fail("badData", "неожиданный формат снимка: " + pixels.length + " значений на " + info.width + "×" + info.height + "×" + info.components);
    }
    if (info.components !== 3 && info.components !== 4) {
      throw fail("badData", "неожиданное число каналов снимка: " + info.components);
    }
    return { info: info, pixels: pixels };
  }

  /**
   * Вставляет результат новым слоем: пиксели RGBA (без умножения на альфу), строки сверху вниз,
   * левый верхний угол — в точке (p.left, p.top) документа. Всё — одной записью в истории.
   */
  async function applyResult(p, pixels) {
    var doc = ps.app.activeDocument;
    if (!doc) throw fail("noDocument");
    if (doc.id !== p.docId) throw fail("docChanged");
    if (!pixels || pixels.length !== p.width * p.height * 4) {
      throw fail("badData", "размер данных не совпадает с " + p.width + "×" + p.height);
    }

    var out = { timings: {} };
    await modal(async function (ctx) {
      var history = ctx.hostControl;
      var suspension = await history.suspendHistory({ documentID: doc.id, name: HISTORY_NAME });
      var ok = false;
      try {
        var t0 = Date.now();
        var layer = await doc.createPixelLayer({ name: p.name });
        out.timings.createLayer = Date.now() - t0;

        var t1 = Date.now();
        // colorProfile не задаём: по документации тогда берётся профиль документа.
        var imageData = await ps.imaging.createImageDataFromBuffer(pixels, {
          width: p.width,
          height: p.height,
          components: 4,
          colorSpace: "RGB",
          chunky: true,
        });
        try {
          await ps.imaging.putPixels({
            documentID: doc.id,
            layerID: layer.id,
            imageData: imageData,
            targetBounds: { left: p.left, top: p.top },
            replace: true,
          });
        } finally {
          imageData.dispose();
        }
        out.timings.putPixels = Date.now() - t1;
        out.layerId = layer.id;
        out.layerName = String(layer.name || p.name);
        ok = true;
      } finally {
        // commit = false откатывает документ к состоянию до suspendHistory
        await history.resumeHistory(suspension, ok);
      }
    }, HISTORY_NAME);
    return out;
  }

  return { readSelectedLayer: readSelectedLayer, readDocumentSnapshot: readDocumentSnapshot, applyResult: applyResult };
}

module.exports = { createPhotoshopApi: createPhotoshopApi };
