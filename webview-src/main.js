// Wrap 3D — интерфейс панели (сторона WebView).
// Этап 4: пресеты контуров, восстановление сцены последнего применения, мягкое затенение.

import { createWebviewBridge } from "./bridge.js";
import { createLogQueue } from "./logqueue.js";
import { Viewport } from "./scene/viewport.js";
import {
  applyDrag,
  applyScale,
  cloneParams,
  defaultParams,
  sanitizeParams,
  setShapeType,
  syncLinked,
} from "./scene/params.js";
import { DEFAULT_VIEW_PREFS, formAppearance, sanitizeViewPrefs } from "./scene/appearance.js";
import { addPreset, fitProfile, removePreset, sanitizePresets } from "./scene/presets.js";
import { profileBounds } from "./scene/profile.js";
import { createPresetsPanel } from "./ui/presets-panel.js";
import { createProfileEditor } from "./ui/profile-editor.js";
import { prepareTexture } from "./scene/pixels.js";
import { createControls } from "./ui/controls.js";
import { attachPointer } from "./ui/pointer.js";
import { applyI18n, getLang, hasKey, langFromLocale, setLang, t } from "./ui/i18n.js";

const $ = (id) => document.getElementById(id);
const MB = 1024 * 1024;
const TEXTURE_PAD = 1; // прозрачная рамка вокруг текстуры, пиксели
const BACKDROP_MAX_SIZE = 2048; // длинная сторона снимка документа для фона
const MODES = ["form", "label", "tilt", "contour"];

// Пока надпись не загружена, поля показывают эту заготовку в выключенном виде.
const PLACEHOLDER = defaultParams({ left: 0, top: 0, width: 100, height: 100 });

const state = {
  connected: false,
  busy: false,
  host: null, // сведения о Photoshop из сообщения hello
  caps: null, // возможности WebGL
  doc: null, // { id, width, height, name }
  label: null, // прямоугольник надписи в документе
  source: null, // сведения о слое-источнике
  params: null, // параметры сцены
  // настройки вида, на результат не влияют
  ui: Object.assign({ backdropOpacity: 70, showForm: true, mode: "form" }, DEFAULT_VIEW_PREFS),
  presets: [], // пресеты контуров; хранятся на стороне UXP
  last: null, // параметры последнего применения; хранятся на стороне UXP
  lastStatus: null, // для повторного вывода при смене языка
};

let bridge = null;
let viewport = null;
let controls = null;
let editor = null;
let presetsPanel = null;
let dragStart = null;

// ---------- журнал ----------

const logLines = [];

// Журнал дублируется в консоль UXP: её видно в UXP Developer Tool, консоль WebView — нет.
const hostLog = createLogQueue((entry) => {
  if (!bridge || !window.uxpHost) return false;
  bridge.emit("log", entry);
  return true;
});

function log(level, text) {
  const fn = console[level] || console.log;
  fn.call(console, "[Wrap3D] " + text);
  const time = new Date().toISOString().slice(11, 23);
  logLines.push(time + " " + (level === "log" ? "" : level.toUpperCase() + " ") + text);
  if (logLines.length > 300) logLines.shift();
  const el = $("diagLog");
  if (el) el.textContent = logLines.join("\n");
  hostLog.push({ level, text });
}

window.addEventListener("error", (e) => {
  log("error", "необработанная ошибка: " + e.message + " @ " + e.filename + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  log("error", "необработанный отказ промиса: " + ((r && (r.stack || r.message)) || r));
});

// ---------- состояние интерфейса ----------

function setStatus(key, kind, vars) {
  state.lastStatus = { key, kind, vars };
  const el = $("status");
  el.textContent = t(key, vars);
  el.className = "status" + (kind ? " " + kind : "");
}

function setStatusText(text, kind) {
  state.lastStatus = null;
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function showError(e) {
  const code = (e && e.code) || "error";
  const message = String((e && e.message) || e);
  log("error", code + ": " + message + (e && e.detail ? " " + JSON.stringify(e.detail) : ""));
  const key = "err." + code;
  const vars = Object.assign({ message }, (e && e.detail) || {});
  setStatusText(hasKey(key) ? t(key, vars) : t("err.generic", { message }), "error");
}

function model() {
  const ui = Object.assign({}, state.ui, { hasLast: !!state.last });
  return Object.assign({}, state.params || PLACEHOLDER, { ui });
}

function updateControls() {
  const ready = state.connected && !!viewport && !state.busy;
  const editable = ready && !!state.label;
  $("btnLoad").disabled = !ready;
  $("btnApply").disabled = !editable;
  $("btnBench").disabled = !state.connected || state.busy;
  $("btnFit").disabled = !state.doc;
  $("langRu").classList.toggle("active", getLang() === "ru");
  $("langEn").classList.toggle("active", getLang() === "en");
  $("hint").style.display = state.label ? "none" : "flex";
  const lathe = !!state.params && state.params.shape.type === "lathe";
  if (state.ui.mode === "contour" && !(lathe && state.label)) state.ui.mode = "form";
  const contour = state.ui.mode === "contour";
  for (const mode of MODES) {
    const button = $("mode-" + mode);
    button.classList.toggle("active", state.ui.mode === mode);
    button.disabled = !editable;
  }
  $("mode-contour").hidden = !lathe;
  // В редакторе контура подсказка длинная — управление видом в ней не повторяется.
  $("mouseHint").textContent = !state.label
    ? ""
    : contour
      ? t("mouse.contour")
      : t("mouse." + state.ui.mode) + " · " + t("mouse.view");

  // Редактор контура занимает место 3D-вида, пока выбран режим «Контур».
  $("viewport").classList.toggle("contour", contour);
  $("contourTools").hidden = !contour;
  if (editor) {
    editor.setActive(contour);
    const point = contour ? editor.selectedPoint() : null;
    $("ptSharp").disabled = !point || !editable;
    $("ptSmooth").disabled = !point || !editable;
    $("ptSharp").classList.toggle("active", !!point && !point.smooth);
    $("ptSmooth").classList.toggle("active", !!point && point.smooth);
    $("ptDelete").disabled = !editable || !editor.canDelete();
  }
  if (controls) controls.update(model(), editable);
  if (presetsPanel) presetsPanel.update(state.presets, editable && lathe);
}

function updateSource() {
  const s = state.source;
  if (!s) {
    $("source").textContent = t("source.none");
    return;
  }
  let text = t("source.info", { name: s.layerName, w: Math.round(s.width), h: Math.round(s.height) });
  if (s.scaled) text += t("source.scaled", { sw: s.srcWidth, sh: s.srcHeight });
  $("source").textContent = text;
}

function updateDiagInfo() {
  const c = state.caps;
  const h = state.host;
  const lines = [];
  if (h) lines.push("Photoshop " + h.ps + " · UXP " + h.uxp + " · " + h.os + " · locale " + (h.locale || "?"));
  if (c) {
    lines.push(c.webgl + " · three r" + c.three);
    if (c.gpu) lines.push(c.gpu);
    lines.push(
      "MAX_TEXTURE_SIZE " + c.maxTextureSize + " · MAX_RENDERBUFFER_SIZE " + c.maxRenderbufferSize + " · MSAA ×" + c.maxSamples,
    );
  }
  lines.push(location.protocol + " · dpr " + (window.devicePixelRatio || 1));
  $("diagInfo").textContent = lines.join("\n");
}

function refreshTexts() {
  applyI18n(document);
  updateSource();
  if (state.lastStatus) setStatus(state.lastStatus.key, state.lastStatus.kind, state.lastStatus.vars);
  updateControls();
}

function setBusy(busy) {
  state.busy = busy;
  updateControls();
}

/** Ждёт следующего кадра, чтобы статус успел отрисоваться; таймер — на случай скрытой панели. */
const nextFrame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 120);
  });

function fmtMb(bytes) {
  return (bytes / MB).toFixed(2) + " МБ";
}

// ---------- сцена ----------

/** Параметры сцены изменились: перестроить вьюпорт и обновить поля. */
function sceneChanged() {
  if (viewport && state.params && state.label) viewport.setParams(state.params);
  updateControls();
  if (editor) editor.draw();
}

function applyUi() {
  if (!viewport) return;
  viewport.setBackdropOpacity(state.ui.backdropOpacity);
  viewport.setShowForm(state.ui.showForm);
  viewport.setFormAppearance(formAppearance(state.ui));
}

/** Личные настройки вида запоминаются на стороне UXP, как язык. */
const VIEW_PREF_KEYS = Object.keys(DEFAULT_VIEW_PREFS);
let viewPrefsTimer = 0;
function saveViewPrefsSoon() {
  clearTimeout(viewPrefsTimer);
  viewPrefsTimer = setTimeout(() => {
    if (!state.connected) return;
    const prefs = {};
    for (const key of VIEW_PREF_KEYS) prefs[key] = state.ui[key];
    bridge.call("saveSettings", prefs, { timeoutMs: 10000 }).catch((e) => {
      log("warn", "настройки вида не сохранены: " + (e && e.message));
    });
  }, 500);
}

/** Изменение из поля, переключателя или флажка. path — "группа.параметр". */
function setParam(path, value) {
  const [group, key] = path.split(".");
  if (group === "ui") {
    state.ui[key] = value;
    applyUi();
    updateControls();
    if (VIEW_PREF_KEYS.includes(key)) saveViewPrefsSoon();
    // исходный слой убирается с фона или возвращается — снимок документа нужен заново
    if (key === "showSource") refreshBackdrop();
    return;
  }
  if (!state.params || !state.label) return;
  if (path === "shape.type") {
    setShapeType(state.params, value, state.label);
    // тело вращения открывается сразу в редакторе контура
    if (value === "lathe") state.ui.mode = "contour";
    if (editor) editor.clearSelection();
  } else {
    state.params[group][key] = value;
    if (path === "placement.wrapAngle") syncLinked(state.params, state.label, "wrapAngle");
    else if (group === "shape" || group === "placement") syncLinked(state.params, state.label, key);
  }
  sceneChanged();
}

function setMode(mode) {
  state.ui.mode = mode;
  updateControls();
}

function sameDocument(info) {
  return !!state.doc && state.doc.id === info.docId && state.doc.width === info.docWidth && state.doc.height === info.docHeight;
}

// ---------- действия ----------

/** Читает сведённое изображение документа и показывает его фоном во вьюпорте. */
async function loadBackdrop() {
  const t0 = performance.now();
  // Исходный слой на снимке скрывается, если не включено «Показывать исходный слой на фоне».
  const request = { maxSize: BACKDROP_MAX_SIZE };
  if (!state.ui.showSource && state.source) request.hideLayerId = state.source.layerId;
  const res = await bridge.call("getSnapshot", request, { timeoutMs: 120000 });
  const info = res.result;
  if (!state.doc || info.docId !== state.doc.id) {
    log("warn", "снимок документа не показан: активен другой документ");
    return false;
  }
  viewport.setBackdrop(info, res.blob);
  const rx = res.rx || {};
  log(
    "log",
    "getSnapshot: " + info.width + "×" + info.height + ", каналов " + info.components +
      ", исходный слой " + (info.hiddenLayer ? "скрыт на снимке" : "не скрывался") +
      " | Photoshop: getPixels " + info.timings.getPixels + " мс, getData " + info.timings.getData + " мс" +
      " | передача " + fmtMb(res.blob.length) + ", приём целиком через " + rx.ms + " мс" +
      " | всего " + Math.round(performance.now() - t0) + " мс",
  );
  return true;
}

/**
 * Читает слой из Photoshop и ставит его в сцену. request — параметры запроса getLayer;
 * chooseParams(label, info) возвращает параметры сцены для этой надписи.
 */
async function readLayerIntoScene(request, chooseParams) {
  const t0 = performance.now();
  const maxSize = Math.min(state.caps.maxTextureSize, 8192) - TEXTURE_PAD * 2;
  const res = await bridge.call("getLayer", Object.assign({ maxSize }, request), { timeoutMs: 120000 });
  const info = res.result;
  const t1 = performance.now();

  const tex = prepareTexture(res.blob, info.srcWidth, info.srcHeight, info.components, TEXTURE_PAD);
  // Текстура может быть уменьшена: kx, ky — пикселей документа на пиксель текстуры.
  const kx = info.width / info.srcWidth;
  const ky = info.height / info.srcHeight;
  const label = {
    left: info.left - tex.pad * kx,
    top: info.top - tex.pad * ky,
    width: tex.width * kx,
    height: tex.height * ky,
  };

  const params = chooseParams(label, info);
  state.doc = { id: info.docId, width: info.docWidth, height: info.docHeight, name: info.docName };
  state.source = info;
  state.label = label;
  state.params = params;
  if (editor) editor.clearSelection();

  viewport.setDocument(state.doc);
  viewport.setLabel(label, tex);
  viewport.setParams(state.params);
  const t2 = performance.now();

  const ptx = res.peerTx || {};
  const rx = res.rx || {};
  log(
    "log",
    "getLayer: слой «" + info.layerName + "» (" + info.layerKind + ") " + info.srcWidth + "×" + info.srcHeight +
      ", каналов " + info.components + (info.scaled ? ", уменьшен из " + Math.round(info.width) + "×" + Math.round(info.height) : "") +
      ", место в документе " + info.left + "," + info.top +
      "; документ " + info.docWidth + "×" + info.docHeight + " " + info.docMode +
      " | Photoshop: getPixels " + info.timings.getPixels + " мс, getData " + info.timings.getData + " мс" +
      " | передача " + fmtMb(res.blob.length) + ", кусков " + (rx.chunks || "?") +
      ": кодирование " + ptx.encodeMs + " мс, отправка " + ptx.postMs + " мс, приём целиком через " + rx.ms +
      " мс (декодирование " + rx.decodeMs + " мс)" +
      " | текстура " + Math.round(t2 - t1) + " мс | всего " + Math.round(t2 - t0) + " мс" +
      " | полупрозрачных пикселей с цветом ярче альфы: " + tex.straightEvidence,
  );
  updateSource();
  updateControls();

  // Фон — отдельным запросом: его сбой не должен мешать работе с надписью.
  setStatus("status.backdrop", "busy");
  try {
    await loadBackdrop();
  } catch (e) {
    log("warn", "фон-документ не загружен: " + ((e && e.code) || "") + " " + ((e && e.message) || e));
  }
  return info;
}

async function loadLayer() {
  if (state.busy) return;
  setBusy(true);
  setStatus("status.loading", "busy");
  const t0 = performance.now();
  try {
    await readLayerIntoScene({}, (label, info) => {
      // В том же документе форма сохраняется: можно положить на неё другую надпись.
      if (state.params && sameDocument(info)) return syncLinked(state.params, label, "scale");
      return defaultParams(label);
    });
    setStatus("status.loaded", "ok", { ms: Math.round(performance.now() - t0) });
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
  }
}

/**
 * Повторное редактирование: при открытии панели восстанавливает сцену последнего применения —
 * читает тот же исходный слой и ставит сохранённые параметры. Если документ или слой уже
 * не те, панель остаётся пустой; параметры можно вернуть кнопкой после загрузки слоя.
 */
async function restoreLastScene() {
  const last = state.last;
  if (!last || last.layerId === undefined || last.layerId === null || !viewport || state.label || state.busy) return;
  setBusy(true);
  setStatus("status.restoring", "busy");
  try {
    const info = await readLayerIntoScene(
      { layerId: last.layerId, expect: { docName: last.docName, docWidth: last.docWidth, docHeight: last.docHeight } },
      () => cloneParams(last.params),
    );
    if (last.ui) {
      if (typeof last.ui.backdropOpacity === "number") state.ui.backdropOpacity = last.ui.backdropOpacity;
      if (typeof last.ui.showForm === "boolean") state.ui.showForm = last.ui.showForm;
      applyUi();
    }
    log("log", "сцена последнего применения восстановлена: слой «" + info.layerName + "», сохранено " + last.savedAt);
    setStatus("status.restored", "ok", { name: info.layerName });
  } catch (e) {
    // Не ошибка: просто открыт другой документ, слой удалён или документа нет.
    log("log", "сцена последнего применения не восстановлена: " + ((e && e.code) || "") + " " + ((e && e.message) || e));
    setStatus("status.ready", "ok");
  } finally {
    setBusy(false);
  }
}

/** Возвращает параметры последнего применения для текущей надписи. */
function applyLastParams() {
  if (state.busy || !state.label || !state.last) return;
  state.params = syncLinked(cloneParams(state.last.params), state.label, "scale");
  if (editor) editor.clearSelection();
  sceneChanged();
  setStatus("status.lastApplied", "ok");
}

/** Запоминает сцену после успешного применения (хранит UXP). */
function rememberLastApplied() {
  const last = {
    version: 1,
    savedAt: new Date().toISOString(),
    docName: state.doc.name,
    docWidth: state.doc.width,
    docHeight: state.doc.height,
    layerId: state.source.layerId,
    layerName: state.source.layerName,
    params: cloneParams(state.params),
    ui: { backdropOpacity: state.ui.backdropOpacity, showForm: state.ui.showForm },
  };
  state.last = last;
  bridge.call("saveLast", { last }, { timeoutMs: 20000 }).then(
    (res) => log("log", "параметры применения сохранены (" + ((res.result && res.result.stored) || "?") + ")"),
    (e) => log("warn", "параметры применения не сохранены: " + ((e && e.message) || e)),
  );
}

// ---------- пресеты контура ----------

function persistPresets() {
  bridge.call("savePresets", { presets: state.presets }, { timeoutMs: 20000 }).then(
    (res) => log("log", "пресеты сохранены: " + state.presets.length + " шт. (" + ((res.result && res.result.stored) || "?") + ")"),
    (e) => log("warn", "пресеты не сохранены: " + ((e && e.message) || e)),
  );
}

function savePreset(name) {
  if (state.busy || !state.params || state.params.shape.type !== "lathe") return;
  const before = state.presets;
  state.presets = addPreset(before, name, state.params.shape.points, t("preset.auto"));
  const clean = String(name || "").trim();
  const saved = state.presets.find((p) => p.name === clean) || state.presets[state.presets.length - 1];
  persistPresets();
  updateControls();
  setStatus("status.presetSaved", "ok", { name: saved.name });
}

function applyPreset(id) {
  if (state.busy || !state.params || state.params.shape.type !== "lathe") return;
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  // Пресет — это пропорции; размер и положение берутся от текущего контура.
  const next = cloneParams(state.params);
  next.shape.points = fitProfile(preset.points, profileBounds(state.params.shape.points));
  state.params = syncLinked(next, state.label, "shape");
  if (editor) editor.clearSelection();
  sceneChanged();
  setStatus("status.presetApplied", "ok", { name: preset.name });
}

function deletePreset(id) {
  if (state.busy) return;
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  state.presets = removePreset(state.presets, id);
  persistPresets();
  updateControls();
  setStatus("status.presetDeleted", "ok", { name: preset.name });
}

async function refreshBackdrop() {
  if (state.busy || !state.doc) return;
  setBusy(true);
  setStatus("status.backdrop", "busy");
  try {
    if (await loadBackdrop()) setStatus("status.backdropDone", "ok");
    else showError({ code: "docChanged", message: "активен другой документ" });
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
  }
}

function resetParams() {
  if (state.busy || !state.label) return;
  state.params = defaultParams(state.label);
  if (editor) editor.clearSelection();
  sceneChanged();
}

async function apply() {
  if (state.busy || !state.label) return;
  setBusy(true);
  setStatus("status.rendering", "busy");
  await nextFrame();
  const t0 = performance.now();
  try {
    const out = viewport.renderOutput();
    if (!out || out.empty) {
      const err = new Error("надпись вне документа");
      err.code = "nothingVisible";
      throw err;
    }
    const t1 = performance.now();
    setStatus("status.sending", "busy");
    const res = await bridge.call(
      "apply",
      {
        docId: state.doc.id,
        left: out.left,
        top: out.top,
        width: out.width,
        height: out.height,
        name: state.source.layerName + " — Wrap 3D",
      },
      { blob: out.pixels, timeoutMs: 180000 },
    );
    const t2 = performance.now();
    const tx = res.tx || {};
    const prx = res.peerRx || {};
    const pt = (res.result && res.result.timings) || {};
    log(
      "log",
      "apply: результат " + out.width + "×" + out.height + " в точке " + out.left + "," + out.top +
        " (область рендера " + out.region.w + "×" + out.region.h + ", плиток " + out.tiles + ", MSAA ×" + out.samples + ")" +
        " | параметры " + JSON.stringify(state.params) +
        " | рендер " + out.timings.render + " мс, обработка " + out.timings.post + " мс" +
        " | передача " + fmtMb(out.pixels.length) + ", кусков " + tx.chunks +
        ": кодирование " + tx.encodeMs + " мс, отправка " + tx.postMs + " мс, приём целиком через " + prx.ms +
        " мс (декодирование " + prx.decodeMs + " мс)" +
        " | Photoshop: слой " + pt.createLayer + " мс, putPixels " + pt.putPixels + " мс" +
        " | всего " + Math.round(t2 - t0) + " мс (из них ожидание Photoshop " + Math.round(t2 - t1) + " мс)",
    );
    setStatus("status.applied", "ok", { name: res.result.layerName, ms: Math.round(t2 - t0) });
    rememberLastApplied();
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
  }
}

/** Тест скорости передачи: 16 МБ туда и обратно кусками разного размера. */
async function benchmark() {
  if (state.busy) return;
  setBusy(true);
  const size = 16 * MB;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = (i * 31 + (i >>> 8)) & 255;
  const variants = [
    { label: "1 МБ", bytes: MB },
    { label: "3 МБ", bytes: 3 * MB },
    { label: "12 МБ", bytes: 12 * MB },
    { label: "целиком", bytes: size + 3 },
  ];
  log("log", "тест передачи: " + fmtMb(size) + " в каждую сторону; времена в мс");
  try {
    for (const v of variants) {
      setStatus("status.bench", "busy", { step: v.label });
      await nextFrame();
      const t0 = performance.now();
      const res = await bridge.call("echo", { chunkBytes: v.bytes }, { blob: payload, chunkBytes: v.bytes, timeoutMs: 300000 });
      const total = Math.round(performance.now() - t0);
      let intact = !!res.blob && res.blob.length === size;
      for (let i = 0; intact && i < size; i += 4099) intact = res.blob[i] === payload[i];
      const tx = res.tx || {};
      const prx = res.peerRx || {};
      const ptx = res.peerTx || {};
      const rx = res.rx || {};
      log(
        "log",
        "кусок " + v.label + " (" + tx.chunks + " шт.)" +
          " | WebView→UXP: кодирование " + tx.encodeMs + ", отправка " + tx.postMs + ", приём целиком через " + prx.ms +
          " (декодирование " + prx.decodeMs + ")" +
          " | UXP→WebView: кодирование " + ptx.encodeMs + ", отправка " + ptx.postMs + ", приём целиком через " + rx.ms +
          " (декодирование " + rx.decodeMs + ")" +
          " | круг " + total + " | данные целы: " + (intact ? "да" : "НЕТ"),
      );
    }
    setStatus("status.benchDone", "ok");
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
  }
}

function chooseLang(lang) {
  setLang(lang);
  refreshTexts();
  if (state.connected) {
    bridge.call("saveSettings", { lang: getLang() }, { timeoutMs: 10000 }).catch((e) => {
      log("warn", "язык не сохранён: " + (e && e.message));
    });
  }
}

// ---------- запуск ----------

function probeLocalStorage() {
  try {
    window.localStorage.setItem("wrap3d.probe", "1");
    window.localStorage.removeItem("wrap3d.probe");
    return "доступен";
  } catch (e) {
    return "недоступен (" + ((e && e.name) || "ошибка") + ")";
  }
}

/** Сообщает UXP, что страница готова; повторяет, пока не придёт hello. */
function startHandshake() {
  let tries = 0;
  const attempt = () => {
    if (state.connected) return;
    tries++;
    if (window.uxpHost) {
      try {
        bridge.emit("ready", {
          caps: state.caps,
          href: location.href,
          userAgent: navigator.userAgent,
          dpr: window.devicePixelRatio || 1,
          localStorage: probeLocalStorage(),
        });
      } catch (e) {
        log("error", "не удалось отправить ready: " + (e && e.message));
      }
      hostLog.flush();
      if (tries === 10) {
        setStatus("status.noReply", "error");
        log("error", "ответ hello не пришёл: сообщения UXP → WebView не доходят");
      }
    } else if (tries === 6) {
      setStatus("status.noHost", "error");
    }
    setTimeout(attempt, tries < 10 ? 500 : 3000);
  };
  attempt();
}

function initViewport() {
  viewport = new Viewport({
    canvas: $("gl"),
    container: $("viewport"),
    docFrame: $("docframe"),
    backdrop: $("backdrop"),
    log,
  });
  viewport.onViewChange = (view) => {
    $("zoom").textContent = Math.round(view.scale * 100) + "%";
    if (editor) editor.draw();
  };
  applyUi();

  const canEdit = () => !!state.label && !!state.params && !state.busy;
  const scaleForm = (factor) => {
    state.params = applyScale(state.ui.mode === "label" ? "label" : "form", state.params, factor, state.label);
    sceneChanged();
  };

  editor = createProfileEditor({
    canvas: $("editor"),
    container: $("viewport"),
    getView: () => viewport.view,
    getParams: () => state.params,
    canEdit,
    onChange: (next) => {
      state.params = next;
      // радиус под надписью мог измениться — пропорции надписи пересчитываются
      syncLinked(state.params, state.label, "shape");
      sceneChanged();
    },
    onSelect: () => updateControls(),
    onPan: (dx, dy) => viewport.panBy(dx, dy),
    onZoom: (factor, x, y) => viewport.zoomAt(factor, x, y),
    onScale: scaleForm,
  });

  attachPointer($("gl"), {
    getMode: () => state.ui.mode,
    canEdit,
    onDragStart: () => {
      dragStart = state.params;
    },
    onDrag: (mode, dxCss, dyCss) => {
      if (!dragStart || !viewport.view) return;
      const scale = viewport.view.scale;
      state.params = applyDrag(mode, dragStart, { dxCss, dyCss, dxDoc: dxCss / scale, dyDoc: dyCss / scale }, state.label);
      sceneChanged();
    },
    onDragEnd: () => {
      dragStart = null;
    },
    onPan: (dx, dy) => viewport.panBy(dx, dy),
    onZoom: (factor, x, y) => viewport.zoomAt(factor, x, y),
    onScale: scaleForm,
  });
}

function init() {
  setLang(langFromLocale(navigator.language));

  controls = createControls($("controls"), {
    onChange: setParam,
    mount: (id, slot) => {
      if (id === "presets") {
        presetsPanel = createPresetsPanel(slot, { onSave: savePreset, onApply: applyPreset, onDelete: deletePreset, t });
      }
    },
    onAction: (id) => {
      if (id === "refreshBackdrop") refreshBackdrop();
      else if (id === "reset") resetParams();
      else if (id === "applyLast") applyLastParams();
      else if (id === "editContour") setMode("contour");
    },
  });

  applyI18n(document);
  updateSource();
  setStatus("status.connecting", "busy");

  bridge = createWebviewBridge(log);

  try {
    initViewport();
    state.caps = viewport.caps();
    log("log", "WebGL: " + JSON.stringify(state.caps));
  } catch (e) {
    viewport = null;
    state.caps = { error: String((e && e.message) || e) };
    log("error", "WebGL не запустился: " + ((e && e.stack) || e));
  }

  bridge.on("hello", (p) => {
    if (state.connected) return;
    state.connected = true;
    state.host = (p && p.host) || {};
    const saved = p && p.settings && p.settings.lang;
    setLang(saved || langFromLocale(state.host.locale));
    Object.assign(state.ui, sanitizeViewPrefs(p && p.settings));
    applyUi();
    // Пресеты и последнее применение хранит UXP; всё прочитанное проверяется.
    state.presets = sanitizePresets(p && p.presets);
    const lastParams = p && p.last ? sanitizeParams(p.last.params) : null;
    state.last = lastParams ? Object.assign({}, p.last, { params: lastParams }) : null;
    refreshTexts();
    updateDiagInfo();
    log(
      "log",
      "связь с UXP установлена: " + JSON.stringify(state.host) +
        "; пресетов " + state.presets.length + ", последнее применение " + (state.last ? "есть (" + state.last.savedAt + ")" : "нет"),
    );
    if (!viewport) {
      showError({ code: "webgl", message: state.caps.error });
      return;
    }
    setStatus("status.ready", "ok");
    restoreLastScene();
  });

  $("btnLoad").addEventListener("click", loadLayer);
  $("btnApply").addEventListener("click", apply);
  $("btnBench").addEventListener("click", benchmark);
  $("btnFit").addEventListener("click", () => viewport && viewport.fit());
  $("langRu").addEventListener("click", () => chooseLang("ru"));
  $("langEn").addEventListener("click", () => chooseLang("en"));
  for (const mode of MODES) $("mode-" + mode).addEventListener("click", () => setMode(mode));
  $("ptSharp").addEventListener("click", () => editor && editor.setSelectedSmooth(false));
  $("ptSmooth").addEventListener("click", () => editor && editor.setSelectedSmooth(true));
  $("ptDelete").addEventListener("click", () => editor && editor.deleteSelected());

  updateDiagInfo();
  updateControls();
  startHandshake();

  // Отладочный доступ из инспектора WebView.
  window.__wrap3d = { state, bridge, viewport, editor, log, setParam, setMode };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
