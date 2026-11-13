// Панель параметров: числовые поля, переключатели и флажки, собранные по описанию ниже.
//
// Числовое поле можно менять тремя способами: ввести число, стрелками вверх/вниз
// (с Shift — в 10 раз быстрее) или потянуть за название поля влево-вправо, как в Photoshop.

import { FIELDS, clampField } from "../scene/params.js";

const isCone = (m) => m.shape.type === "cone";
const isSphere = (m) => m.shape.type === "sphere";
const isLathe = (m) => m.shape.type === "lathe";

const GROUPS = [
  {
    title: "grp.shape",
    items: [
      {
        kind: "choice",
        path: "shape.type",
        options: [
          ["cylinder", "shape.cylinder"],
          ["sphere", "shape.sphere"],
          ["cone", "shape.cone"],
          ["lathe", "shape.lathe"],
        ],
      },
      { kind: "num", path: "shape.radius", label: "f.radius", when: (m) => !isCone(m) && !isLathe(m) },
      { kind: "num", path: "shape.radiusTop", label: "f.radiusTop", when: isCone },
      { kind: "num", path: "shape.radiusBottom", label: "f.radiusBottom", when: isCone },
      { kind: "num", path: "shape.height", label: "f.height", when: (m) => !isSphere(m) && !isLathe(m) },
      { kind: "action", id: "editContour", label: "btn.editContour", when: isLathe },
      { kind: "custom", id: "presets", when: isLathe },
      // Как форма показана во вьюпорте. На результат не влияет: в документ попадает только надпись.
      { kind: "check", path: "ui.showForm", label: "f.showForm" },
      {
        kind: "choice",
        path: "ui.formStyle",
        label: "f.formStyle",
        when: (m) => m.ui.showForm,
        options: [
          ["rim", "form.rim"],
          ["solid", "form.solid"],
        ],
      },
      {
        kind: "range",
        path: "ui.formOpacity",
        label: "f.formOpacity",
        when: (m) => m.ui.showForm && m.ui.formStyle === "solid",
      },
    ],
  },
  {
    title: "grp.transform",
    items: [
      { kind: "num", path: "transform.x", label: "f.x" },
      { kind: "num", path: "transform.y", label: "f.y" },
      { kind: "num", path: "transform.scale", label: "f.scale" },
      { kind: "num", path: "transform.tilt", label: "f.tilt" },
      { kind: "num", path: "transform.roll", label: "f.roll" },
    ],
  },
  {
    title: "grp.label",
    items: [
      { kind: "num", path: "placement.offset", label: "f.offset" },
      { kind: "num", path: "placement.rotation", label: "f.rotation" },
      { kind: "num", path: "placement.scale", label: "f.scale" },
      { kind: "num", path: "placement.wrapAngle", label: "f.wrapAngle" },
      { kind: "check", path: "placement.linked", label: "f.linked" },
      { kind: "check", path: "placement.hideBack", label: "f.hideBack" },
    ],
  },
  {
    title: "grp.camera",
    items: [
      {
        kind: "choice",
        path: "camera.type",
        options: [
          ["ortho", "cam.ortho"],
          ["persp", "cam.persp"],
        ],
      },
      { kind: "num", path: "camera.fov", label: "f.fov", when: (m) => m.camera.type === "persp" },
    ],
  },
  {
    title: "grp.light",
    items: [
      { kind: "check", path: "light.shading", label: "f.shading" },
      { kind: "num", path: "light.strength", label: "f.shadeStrength", when: (m) => m.light.shading },
    ],
  },
  {
    title: "grp.view",
    items: [
      { kind: "num", path: "ui.backdropOpacity", label: "f.backdropOpacity" },
      { kind: "check", path: "ui.showSource", label: "f.showSource" },
      { kind: "action", id: "refreshBackdrop", label: "btn.refreshBackdrop" },
      { kind: "action", id: "reset", label: "btn.reset" },
      { kind: "action", id: "applyLast", label: "btn.applyLast", enabled: (m) => m.ui.hasLast },
    ],
  },
];

// Значок «тянуть влево-вправо»: показывает, что значение меняется перетаскиванием.
const GRIP_SVG =
  '<svg viewBox="0 0 14 8" width="14" height="8" aria-hidden="true">' +
  '<path d="M4 1 L1 4 L4 7 M10 1 L13 4 L10 7 M1 4 H13" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function make(tag, className, i18nKey) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (i18nKey) node.setAttribute("data-i18n", i18nKey);
  return node;
}

function read(model, path) {
  const [group, key] = path.split(".");
  return model[group] ? model[group][key] : undefined;
}

/** Число для поля: один знак после запятой, без хвостовых нулей. */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 10) / 10);
}

/**
 * handlers.onChange(path, value) — параметр изменён; handlers.onAction(id) — нажата кнопка;
 * handlers.mount(id, element) — построить свой блок в отведённом месте.
 * Возвращает { update(model, enabled) }.
 */
export function createControls(root, handlers) {
  const updaters = [];
  let current = null;

  function buildNumber(def) {
    const field = FIELDS[def.path] || { step: 1, unit: "" };
    const row = make("div", "fld");
    // Зона перетаскивания: название параметра и значок со стрелками рядом с числом.
    const zone = make("span", "fld-scrub");
    zone.setAttribute("data-i18n-title", "hint.scrub");
    const name = make("span", "fld-name", def.label);
    const grip = make("span", "fld-grip");
    grip.innerHTML = GRIP_SVG;
    zone.append(name, grip);
    const box = make("span", "fld-box");
    const input = make("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.spellcheck = false;
    input.autocomplete = "off";
    const unit = make("span", "unit");
    unit.textContent = field.unit || "";
    box.append(input, unit);
    row.append(zone, box);

    const commit = (raw) => {
      const value = clampField(def.path, String(raw).replace(",", ".").trim());
      if (value === null || String(raw).trim() === "") {
        if (current) input.value = formatNumber(read(current, def.path));
        return;
      }
      handlers.onChange(def.path, value);
    };

    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        input.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        if (!current) return;
        const direction = e.key === "ArrowUp" ? 1 : -1;
        const base = clampField(def.path, input.value.replace(",", "."));
        const start = base === null ? read(current, def.path) : base;
        const value = clampField(def.path, start + direction * field.step * (e.shiftKey ? 10 : 1));
        input.value = formatNumber(value);
        handlers.onChange(def.path, value);
      }
    });

    // Перетаскивание за название поля или значок со стрелками
    let scrub = null;
    zone.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || input.disabled || !current) return;
      scrub = { id: e.pointerId, x: e.clientX, start: read(current, def.path) };
      try {
        zone.setPointerCapture(e.pointerId);
      } catch (err) {
        /* без захвата работает, пока курсор над названием */
      }
      row.classList.add("scrubbing");
      input.blur();
      e.preventDefault();
    });
    zone.addEventListener("pointermove", (e) => {
      if (!scrub || e.pointerId !== scrub.id) return;
      const speed = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const value = clampField(def.path, scrub.start + Math.round(e.clientX - scrub.x) * field.step * speed);
      handlers.onChange(def.path, value);
    });
    const stop = (e) => {
      if (!scrub || e.pointerId !== scrub.id) return;
      scrub = null;
      row.classList.remove("scrubbing");
    };
    zone.addEventListener("pointerup", stop);
    zone.addEventListener("pointercancel", stop);

    updaters.push((model, enabled) => {
      const visible = !def.when || def.when(model);
      row.hidden = !visible;
      input.disabled = !enabled;
      row.classList.toggle("disabled", !enabled);
      if (document.activeElement !== input) input.value = enabled ? formatNumber(read(model, def.path)) : "";
    });
    return row;
  }

  function buildChoice(def) {
    const row = make("div", "seg wide");
    const buttons = def.options.map(([value, key]) => {
      const button = make("button", "seg-btn", key);
      button.type = "button";
      button.addEventListener("click", () => handlers.onChange(def.path, value));
      row.append(button);
      return [value, button];
    });
    // С подписью переключатель оборачивается: подпись сверху, кнопки под ней.
    let root = row;
    if (def.label) {
      root = make("div", "choice");
      root.append(make("div", "choice-label", def.label), row);
    }
    updaters.push((model, enabled) => {
      root.hidden = !!def.when && !def.when(model);
      for (const [value, button] of buttons) {
        button.disabled = !enabled;
        button.classList.toggle("active", enabled && read(model, def.path) === value);
      }
    });
    return root;
  }

  /** Ползунок с числом справа. */
  function buildRange(def) {
    const field = FIELDS[def.path];
    const row = make("div", "fld rng");
    const name = make("span", "rng-name", def.label);
    const input = make("input");
    input.type = "range";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    const value = make("span", "rng-value");
    row.append(name, input, value);
    input.addEventListener("input", () => handlers.onChange(def.path, clampField(def.path, input.value)));
    updaters.push((model, enabled) => {
      row.hidden = !!def.when && !def.when(model);
      input.disabled = !enabled;
      row.classList.toggle("disabled", !enabled);
      const current = read(model, def.path);
      input.value = String(current);
      value.textContent = formatNumber(current) + " " + (field.unit || "");
    });
    return row;
  }

  function buildCheck(def) {
    const row = make("label", "chk wide");
    const input = make("input");
    input.type = "checkbox";
    const text = make("span", "", def.label);
    row.append(input, text);
    input.addEventListener("change", () => handlers.onChange(def.path, input.checked));
    updaters.push((model, enabled) => {
      input.disabled = !enabled;
      row.classList.toggle("disabled", !enabled);
      input.checked = !!read(model, def.path);
    });
    return row;
  }

  function buildAction(def) {
    const button = make("button", "btn small", def.label);
    button.type = "button";
    button.addEventListener("click", () => handlers.onAction(def.id));
    updaters.push((model, enabled) => {
      button.hidden = !!def.when && !def.when(model);
      button.disabled = !enabled || (!!def.enabled && !def.enabled(model));
    });
    return button;
  }

  /** Место под блок, который строит вызывающий код (handlers.mount). */
  function buildCustom(def) {
    const slot = make("div", "wide");
    handlers.mount(def.id, slot);
    updaters.push((model) => {
      slot.hidden = !!def.when && !def.when(model);
    });
    return slot;
  }

  root.textContent = "";
  // Строка-подсказка над параметрами: без неё перетаскивание значений легко не заметить.
  const scrubHint = make("div", "ctl-hint");
  const scrubHintIcon = make("span", "fld-grip");
  scrubHintIcon.innerHTML = GRIP_SVG;
  scrubHint.append(scrubHintIcon, make("span", "", "hint.scrubLine"));
  root.append(scrubHint);

  for (const group of GROUPS) {
    const details = make("details", "grp");
    details.open = true;
    details.append(make("summary", "", group.title));
    const grid = make("div", "grid");
    for (const def of group.items) {
      if (def.kind === "num") grid.append(buildNumber(def));
      else if (def.kind === "choice") grid.append(buildChoice(def));
      else if (def.kind === "check") grid.append(buildCheck(def));
      else if (def.kind === "range") grid.append(buildRange(def));
      else if (def.kind === "action") grid.append(buildAction(def));
      else if (def.kind === "custom") grid.append(buildCustom(def));
    }
    details.append(grid);
    root.append(details);
  }

  return {
    /** model: { shape, transform, placement, camera, ui }; enabled — есть ли загруженная надпись. */
    update(model, enabled) {
      current = enabled ? model : null;
      for (const fn of updaters) fn(model, enabled);
    },
  };
}
