// Список пресетов контура: сохранить текущий контур, применить или удалить сохранённый.
// Обычные кнопки вместо выпадающего списка — системные меню внутри WebView панели не проверены.

function make(tag, className, i18nKey) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (i18nKey) node.setAttribute("data-i18n", i18nKey);
  return node;
}

/**
 * handlers: onSave(name), onApply(id), onDelete(id), t(key) — перевод строки.
 * Возвращает { update(presets, enabled) }.
 */
export function createPresetsPanel(root, handlers) {
  root.classList.add("presets");

  const title = make("div", "presets-title", "preset.title");

  const saveRow = make("div", "presets-save");
  const name = make("input", "presets-name");
  name.type = "text";
  name.spellcheck = false;
  name.autocomplete = "off";
  name.setAttribute("data-i18n-placeholder", "preset.name");
  const save = make("button", "btn small", "preset.save");
  save.type = "button";
  saveRow.append(name, save);

  const list = make("div", "presets-list");
  const empty = make("div", "presets-empty", "preset.empty");

  root.append(title, saveRow, list, empty);

  const doSave = () => {
    handlers.onSave(name.value);
    name.value = "";
    name.blur();
  };
  save.addEventListener("click", doSave);
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSave();
  });

  return {
    update(presets, enabled) {
      save.disabled = !enabled;
      name.disabled = !enabled;
      list.textContent = "";
      for (const preset of presets) {
        const row = make("div", "presets-row");
        const apply = make("button", "btn small presets-apply");
        apply.type = "button";
        apply.textContent = preset.name;
        apply.title = preset.name;
        apply.disabled = !enabled;
        apply.addEventListener("click", () => handlers.onApply(preset.id));
        const remove = make("button", "btn small presets-remove");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = handlers.t("preset.delete"); // строки списка пересоздаются, поэтому текст берётся сразу
        remove.disabled = !enabled;
        remove.addEventListener("click", () => handlers.onDelete(preset.id));
        row.append(apply, remove);
        list.append(row);
      }
      empty.hidden = presets.length > 0;
    },
  };
}
