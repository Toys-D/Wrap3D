import test from "node:test";
import assert from "node:assert/strict";
import photoshopApi from "../plugin/src/photoshop.js";
import storageApi from "../plugin/src/storage.js";
import { fakePhotoshop } from "./helpers/fake-photoshop.mjs";

const { createPhotoshopApi } = photoshopApi;
const { createStorage } = storageApi;

const names = (calls) => calls.map((c) => c[0]);
const find = (calls, name) => calls.find((c) => c[0] === name);

test("readSelectedLayer без открытого документа — ошибка noDocument", async () => {
  const { ps } = fakePhotoshop({ activeDocument: null });
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "noDocument");
});

test("readSelectedLayer без выделенного слоя — ошибка noLayer", async () => {
  const { ps } = fakePhotoshop({ doc: { activeLayers: [] } });
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "noLayer");
});

test("readSelectedLayer с несколькими выделенными слоями — ошибка multiLayer", async () => {
  const { ps, layer } = fakePhotoshop();
  ps.app.activeDocument.activeLayers = [layer, { ...layer, id: 13 }];
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "multiLayer");
});

test("readSelectedLayer в документе CMYK — ошибка unsupportedMode", async () => {
  const { ps } = fakePhotoshop({ doc: { mode: "CMYKColorMode" } });
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "unsupportedMode");
});

test("readSelectedLayer для пустого слоя — ошибка emptyLayer", async () => {
  const { ps } = fakePhotoshop({ layer: { boundsNoEffects: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } } });
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "emptyLayer");
});

test("readSelectedLayer возвращает пиксели слоя и его положение в документе", async () => {
  const { ps, calls, layerPixels } = fakePhotoshop();
  const res = await createPhotoshopApi(ps).readSelectedLayer({ maxSize: 8192 });
  assert.deepEqual(res.pixels, layerPixels);
  const { timings, ...info } = res.info;
  assert.deepEqual(info, {
    docId: 5,
    docName: "bottle.psd",
    docWidth: 1600,
    docHeight: 1200,
    docMode: "RGBColorMode",
    layerId: 12,
    layerName: "Logo",
    layerKind: "text",
    // положение — из sourceBounds, которые вернул getPixels
    left: 352,
    top: 471,
    width: 900,
    height: 260,
    srcWidth: 900,
    srcHeight: 260,
    components: 4,
    scaled: false,
  });
  assert.equal(typeof timings.getPixels, "number");
  assert.deepEqual(find(calls, "getPixels")[1], { documentID: 5, layerID: 12, colorSpace: "RGB", componentSize: 8 });
  assert.ok(names(calls).includes("dispose"), "данные изображения освобождены");
});

test("readSelectedLayer уменьшает слой, который больше предельного размера текстуры", async () => {
  const { ps, calls } = fakePhotoshop({
    layer: { boundsNoEffects: { left: 100, top: 200, right: 4100, bottom: 1200, width: 4000, height: 1000 } },
  });
  const res = await createPhotoshopApi(ps).readSelectedLayer({ maxSize: 1000 });
  const opts = find(calls, "getPixels")[1];
  assert.deepEqual(opts.targetSize, { width: 1000, height: 250 });
  assert.deepEqual(opts.sourceBounds, { left: 100, top: 200, right: 4100, bottom: 1200 });
  assert.equal(res.info.scaled, true);
  // положение в документе остаётся в полном размере, уменьшена только текстура
  assert.deepEqual(
    { left: res.info.left, top: res.info.top, width: res.info.width, height: res.info.height },
    { left: 100, top: 200, width: 4000, height: 1000 },
  );
  assert.deepEqual({ w: res.info.srcWidth, h: res.info.srcHeight }, { w: 1000, h: 250 });
  assert.equal(res.pixels.length, 1000 * 250 * 4);
});

test("readSelectedLayer: Photoshop занят (ошибка 9 из executeAsModal) — код psBusy", async () => {
  const busy = new Error("host is in a modal state");
  busy.number = 9;
  const { ps } = fakePhotoshop({ modalError: busy });
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({}), (e) => e.code === "psBusy");
});

test("readDocumentSnapshot отдаёт уменьшенное сведённое изображение документа", async () => {
  const { ps, calls } = fakePhotoshop(); // документ 1600×1200
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ maxSize: 800 });
  const opts = find(calls, "getPixels")[1];
  assert.equal(opts.layerID, undefined, "без layerID — весь документ");
  assert.equal(opts.documentID, 5);
  assert.deepEqual(opts.targetSize, { width: 800 }, "уменьшается по длинной стороне");
  const { timings, ...info } = res.info;
  assert.deepEqual(info, { docId: 5, docWidth: 1600, docHeight: 1200, width: 800, height: 600, components: 3, hiddenLayer: false });
  assert.equal(typeof timings.getPixels, "number");
  assert.equal(res.pixels.length, 800 * 600 * 3);
  assert.ok(names(calls).includes("dispose"));
});

test("readDocumentSnapshot для вертикального документа уменьшает по высоте", async () => {
  const { ps, calls } = fakePhotoshop({ doc: { width: 1000, height: 3000 } });
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ maxSize: 1500 });
  assert.deepEqual(find(calls, "getPixels")[1].targetSize, { height: 1500 });
  assert.deepEqual({ w: res.info.width, h: res.info.height }, { w: 500, h: 1500 });
});

test("readDocumentSnapshot не увеличивает маленький документ", async () => {
  const { ps, calls } = fakePhotoshop();
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ maxSize: 4096 });
  assert.equal(find(calls, "getPixels")[1].targetSize, undefined);
  assert.deepEqual({ w: res.info.width, h: res.info.height }, { w: 1600, h: 1200 });
});

test("readDocumentSnapshot без открытого документа — ошибка noDocument", async () => {
  const { ps } = fakePhotoshop({ activeDocument: null });
  await assert.rejects(createPhotoshopApi(ps).readDocumentSnapshot({}), (e) => e.code === "noDocument");
});

test("readDocumentSnapshot с hideLayerId снимает документ без исходного слоя и ничего в нём не меняет", async () => {
  const { ps, calls, layer } = fakePhotoshop();
  ps.app.activeDocument.layers = [{ id: 40, name: "Группа", layers: [layer] }];
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ maxSize: 800, hideLayerId: 12 });
  assert.deepEqual(names(calls), [
    "executeAsModal",
    "suspendHistory",
    "setVisible",
    "getPixels",
    "dispose",
    "setVisible",
    "resumeHistory",
  ]);
  assert.equal(find(calls, "getPixels")[2].layerVisible, false, "в момент снимка слой скрыт");
  assert.equal(layer.visible, true, "видимость возвращена");
  assert.deepEqual(find(calls, "resumeHistory").slice(1), [77, false], "история откатывается — записи не остаётся");
  assert.equal(res.info.hiddenLayer, true);
});

test("readDocumentSnapshot не трогает слой, который и так скрыт", async () => {
  const { ps, calls, layer } = fakePhotoshop({ layer: { visible: false } });
  ps.app.activeDocument.layers = [layer];
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ hideLayerId: 12 });
  assert.ok(!names(calls).includes("setVisible") && !names(calls).includes("suspendHistory"));
  assert.equal(layer.visible, false);
  assert.equal(res.info.hiddenLayer, false);
});

test("readDocumentSnapshot: слоя с таким номером нет — обычный снимок без ошибки", async () => {
  const { ps, calls, layer } = fakePhotoshop();
  ps.app.activeDocument.layers = [layer];
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ hideLayerId: 999 });
  assert.ok(!names(calls).includes("setVisible"));
  assert.equal(res.info.hiddenLayer, false);
  assert.equal(res.pixels.length, 1600 * 1200 * 3);
});

test("readDocumentSnapshot при сбое чтения всё равно возвращает слою видимость", async () => {
  const { ps, calls, layer } = fakePhotoshop({ getPixelsError: new Error("нет памяти") });
  ps.app.activeDocument.layers = [layer];
  await assert.rejects(createPhotoshopApi(ps).readDocumentSnapshot({ hideLayerId: 12 }), (e) => e.code === "psError");
  assert.equal(layer.visible, true);
  assert.deepEqual(find(calls, "resumeHistory").slice(1), [77, false]);
});

test("readDocumentSnapshot без hideLayerId историю не трогает", async () => {
  const { ps, calls } = fakePhotoshop();
  const res = await createPhotoshopApi(ps).readDocumentSnapshot({ maxSize: 800 });
  assert.ok(!names(calls).includes("suspendHistory") && !names(calls).includes("setVisible"));
  assert.equal(res.info.hiddenLayer, false);
});

function applyParams(over = {}) {
  return { docId: 5, left: 300, top: 400, width: 4, height: 2, name: "Logo — Wrap 3D", ...over };
}

test("applyResult создаёт слой и кладёт пиксели на место одной записью в истории", async () => {
  const { ps, calls } = fakePhotoshop();
  const pixels = new Uint8Array(4 * 2 * 4).fill(200);
  const res = await createPhotoshopApi(ps).applyResult(applyParams(), pixels);

  assert.deepEqual(names(calls), [
    "executeAsModal",
    "suspendHistory",
    "createPixelLayer",
    "createImageDataFromBuffer",
    "putPixels",
    "dispose",
    "resumeHistory",
  ]);
  assert.deepEqual(find(calls, "suspendHistory")[1], { documentID: 5, name: "Wrap 3D" });
  assert.deepEqual(find(calls, "createPixelLayer")[1], { name: "Logo — Wrap 3D" });
  const [, buffer, imageOpts] = find(calls, "createImageDataFromBuffer");
  assert.equal(buffer, pixels);
  assert.deepEqual(imageOpts, { width: 4, height: 2, components: 4, colorSpace: "RGB", chunky: true });
  const put = find(calls, "putPixels")[1];
  assert.equal(put.documentID, 5);
  assert.equal(put.layerID, 99);
  assert.deepEqual(put.targetBounds, { left: 300, top: 400 });
  assert.equal(put.replace, true);
  assert.deepEqual(find(calls, "resumeHistory").slice(1), [77, true]);
  assert.equal(res.layerId, 99);
  assert.equal(res.layerName, "Logo — Wrap 3D");
});

test("applyResult при ошибке записи откатывает историю и сообщает psError", async () => {
  const { ps, calls } = fakePhotoshop({ putPixelsError: new Error("Invalid image data") });
  const pixels = new Uint8Array(4 * 2 * 4);
  await assert.rejects(createPhotoshopApi(ps).applyResult(applyParams(), pixels), (e) => {
    assert.equal(e.code, "psError");
    assert.match(e.message, /Invalid image data/);
    return true;
  });
  assert.deepEqual(find(calls, "resumeHistory").slice(1), [77, false]);
});

test("applyResult отказывается писать в другой документ", async () => {
  const { ps, calls } = fakePhotoshop();
  const pixels = new Uint8Array(4 * 2 * 4);
  await assert.rejects(createPhotoshopApi(ps).applyResult(applyParams({ docId: 6 }), pixels), (e) => e.code === "docChanged");
  assert.deepEqual(calls, []);
});

test("applyResult отказывается от данных неверного размера", async () => {
  const { ps, calls } = fakePhotoshop();
  await assert.rejects(createPhotoshopApi(ps).applyResult(applyParams(), new Uint8Array(10)), (e) => e.code === "badData");
  assert.deepEqual(calls, []);
});

function fakeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}

test("storage.load возвращает пустые настройки, если ничего не сохранено", () => {
  assert.deepEqual(createStorage(fakeLocalStorage()).load(), {});
});

test("storage.save дополняет сохранённые настройки и они читаются заново", () => {
  const ls = fakeLocalStorage();
  createStorage(ls).save({ lang: "en" });
  createStorage(ls).save({ other: 1 });
  assert.deepEqual(createStorage(ls).load(), { lang: "en", other: 1 });
});

test("storage.load переживает испорченные данные", () => {
  assert.deepEqual(createStorage(fakeLocalStorage({ "wrap3d.settings": "{не json" })).load(), {});
});

test("storage не падает, если хранилище недоступно", () => {
  const broken = {
    getItem: () => {
      throw new Error("нет доступа");
    },
    setItem: () => {
      throw new Error("нет доступа");
    },
  };
  const storage = createStorage(broken);
  assert.deepEqual(storage.load(), {});
  assert.deepEqual(storage.save({ lang: "ru" }), { lang: "ru" });
});

// ---------- файлы в папке данных плагина ----------

function fakeFileStore(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: async (name) => (files.has(name) ? files.get(name) : null),
    write: async (name, text) => void files.set(name, text),
  };
}

test("storage.readJson возвращает null, пока файла нет", async () => {
  const storage = createStorage(fakeLocalStorage(), undefined, fakeFileStore());
  assert.equal(await storage.readJson("presets.json"), null);
});

test("storage.writeJson сохраняет данные в файл, readJson читает их обратно", async () => {
  const fileStore = fakeFileStore();
  await createStorage(fakeLocalStorage(), undefined, fileStore).writeJson("presets.json", [{ id: "p1" }]);
  assert.deepEqual(JSON.parse(fileStore.files.get("presets.json")), [{ id: "p1" }]);
  assert.deepEqual(await createStorage(fakeLocalStorage(), undefined, fileStore).readJson("presets.json"), [{ id: "p1" }]);
});

test("storage: если файл не пишется, данные уходят в localStorage и читаются оттуда", async () => {
  const ls = fakeLocalStorage();
  const broken = {
    read: async () => {
      throw new Error("нет доступа");
    },
    write: async () => {
      throw new Error("нет доступа");
    },
  };
  const warnings = [];
  const log = (level, text) => warnings.push(level + ": " + text);
  await createStorage(ls, log, broken).writeJson("last.json", { a: 1 });
  assert.deepEqual(await createStorage(ls, log, broken).readJson("last.json"), { a: 1 });
  assert.ok(warnings.length > 0, "о сбое сообщено в журнал");
});

test("storage работает без файлового хранилища", async () => {
  const ls = fakeLocalStorage();
  await createStorage(ls).writeJson("last.json", { b: 2 });
  assert.deepEqual(await createStorage(ls).readJson("last.json"), { b: 2 });
});

test("storage.readJson переживает испорченный файл", async () => {
  const storage = createStorage(fakeLocalStorage(), undefined, fakeFileStore({ "presets.json": "{не json" }));
  assert.equal(await storage.readJson("presets.json"), null);
});

// ---------- чтение слоя по номеру (восстановление сцены) ----------

test("readSelectedLayer с layerId читает этот слой, даже если выделен другой и слой лежит в группе", async () => {
  const { ps, calls, layer } = fakePhotoshop();
  const other = { ...layer, id: 77, name: "Другой" };
  ps.app.activeDocument.activeLayers = [other];
  ps.app.activeDocument.layers = [other, { id: 30, name: "Группа", layers: [{ id: 31, name: "Вложенная", layers: [layer] }] }];
  const res = await createPhotoshopApi(ps).readSelectedLayer({ layerId: 12 });
  assert.equal(res.info.layerId, 12);
  assert.equal(res.info.layerName, "Logo");
  assert.equal(find(calls, "getPixels")[1].layerID, 12);
});

test("readSelectedLayer с layerId: слоя больше нет — ошибка layerGone", async () => {
  const { ps, layer } = fakePhotoshop();
  ps.app.activeDocument.layers = [layer];
  await assert.rejects(createPhotoshopApi(ps).readSelectedLayer({ layerId: 999 }), (e) => e.code === "layerGone");
});

test("readSelectedLayer с expect: другой документ — ошибка docMismatch, пиксели не читаются", async () => {
  const { ps, calls, layer } = fakePhotoshop();
  ps.app.activeDocument.layers = [layer];
  const api = createPhotoshopApi(ps);
  await assert.rejects(
    api.readSelectedLayer({ layerId: 12, expect: { docName: "другой.psd", docWidth: 1600, docHeight: 1200 } }),
    (e) => e.code === "docMismatch",
  );
  assert.deepEqual(calls, []);
  const ok = await api.readSelectedLayer({ layerId: 12, expect: { docName: "bottle.psd", docWidth: 1600, docHeight: 1200 } });
  assert.equal(ok.info.layerId, 12);
});
