import test from "node:test";
import assert from "node:assert/strict";
import { createLogQueue } from "../webview-src/logqueue.js";

test("записи, сделанные до появления связи, доставляются позже и по порядку", () => {
  let online = false;
  const sent = [];
  const queue = createLogQueue((entry) => {
    if (!online) return false;
    sent.push(entry.text);
    return true;
  });
  queue.push({ level: "log", text: "первая" });
  queue.push({ level: "log", text: "вторая" });
  assert.deepEqual(sent, []);
  online = true;
  queue.push({ level: "log", text: "третья" });
  assert.deepEqual(sent, ["первая", "вторая", "третья"]);
});

test("flush доставляет накопленное без новой записи", () => {
  let online = false;
  const sent = [];
  const queue = createLogQueue((entry) => online && sent.push(entry.text) > 0);
  queue.push({ level: "log", text: "ранняя" });
  online = true;
  queue.flush();
  assert.deepEqual(sent, ["ранняя"]);
});

test("без связи очередь не растёт бесконечно: самые старые записи отбрасываются", () => {
  const sent = [];
  let online = false;
  const queue = createLogQueue((entry) => online && sent.push(entry.text) > 0, 3);
  for (let i = 1; i <= 5; i++) queue.push({ level: "log", text: "запись " + i });
  online = true;
  queue.flush();
  assert.deepEqual(sent, ["запись 3", "запись 4", "запись 5"]);
});

test("сбой отправки не теряет запись", () => {
  let fail = true;
  const sent = [];
  const queue = createLogQueue((entry) => {
    if (fail) throw new Error("канал закрыт");
    sent.push(entry.text);
    return true;
  });
  assert.doesNotThrow(() => queue.push({ level: "log", text: "важная" }));
  fail = false;
  queue.flush();
  assert.deepEqual(sent, ["важная"]);
});
