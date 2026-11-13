import test from "node:test";
import assert from "node:assert/strict";
import transfer from "../plugin/src/transfer.js";

const { base64Encode, base64DecodeInto, createBridge } = transfer;

function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** Два моста, соединённые «проводом»; tap может подсмотреть или выбросить сообщение (вернув false). */
function link(optsA = {}, optsB = {}, tap) {
  let a, b;
  const wire = (getPeer, dir) => (s) => {
    if (tap && tap(dir, s) === false) return;
    setTimeout(() => getPeer().receive(s), 0);
  };
  a = createBridge({ name: "a", post: wire(() => b, "a>b"), ...optsA });
  b = createBridge({ name: "b", post: wire(() => a, "b>a"), ...optsB });
  return { a, b };
}

test("base64Encode совпадает с эталоном для длин 0..10", () => {
  for (let n = 0; n <= 10; n++) {
    const bytes = randomBytes(n, n + 7);
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"), `длина ${n}`);
  }
});

test("base64Encode совпадает с эталоном на большом массиве", () => {
  const bytes = randomBytes(100003, 42);
  assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"));
});

test("base64Encode кодирует только указанный диапазон", () => {
  const bytes = randomBytes(50, 3);
  assert.equal(base64Encode(bytes, 5, 26), Buffer.from(bytes.subarray(5, 26)).toString("base64"));
});

test("base64DecodeInto пишет байты по смещению и возвращает их количество", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 1000, 1001, 1002]) {
    const bytes = randomBytes(n, n + 11);
    const header = "заголовок:";
    const str = header + Buffer.from(bytes).toString("base64");
    const dest = new Uint8Array(n + 20).fill(0xee);
    const written = base64DecodeInto(str, header.length, dest, 10);
    assert.equal(written, n, `длина ${n}`);
    assert.deepEqual(dest.subarray(10, 10 + n), bytes, `данные, длина ${n}`);
    assert.equal(dest[9], 0xee, "байт перед данными не тронут");
    assert.equal(dest[10 + n], 0xee, "байт после данных не тронут");
  }
});

test("base64DecodeInto отказывается писать за границу буфера", () => {
  const str = Buffer.from(randomBytes(30)).toString("base64");
  assert.throws(() => base64DecodeInto(str, 0, new Uint8Array(29), 0));
});

test("call возвращает результат обработчика", async () => {
  const { a, b } = link();
  b.handle("sum", async (p) => ({ result: { total: p.x + p.y } }));
  const res = await a.call("sum", { x: 2, y: 5 });
  assert.deepEqual(res.result, { total: 7 });
});

test("call доставляет двоичные данные обработчику несколькими кусками без искажений", async () => {
  const { a, b } = link({ chunkBytes: 3000 });
  const blob = randomBytes(10000, 5);
  let received = null;
  b.handle("store", async (p, data) => {
    received = data;
    return { result: { length: data.length } };
  });
  const res = await a.call("store", {}, { blob });
  assert.deepEqual(res.result, { length: 10000 });
  assert.deepEqual(received, blob);
  assert.equal(res.tx.bytes, 10000);
  assert.equal(res.tx.chunks, 4);
  assert.equal(res.peerRx.bytes, 10000);
  assert.equal(res.peerRx.chunks, 4);
});

test("обработчик может вернуть двоичные данные вызывающей стороне", async () => {
  const { a, b } = link({}, { chunkBytes: 3000 });
  const blob = randomBytes(7001, 9);
  b.handle("load", async () => ({ result: { name: "слой" }, blob }));
  const res = await a.call("load", {});
  assert.deepEqual(res.result, { name: "слой" });
  assert.deepEqual(res.blob, blob);
  assert.equal(res.rx.bytes, 7001);
  assert.equal(res.rx.chunks, 3);
});

test("размер куска можно задать на один вызов и на ответ", async () => {
  const { a, b } = link();
  const blob = randomBytes(9000, 13);
  b.handle("echo", async (p, data) => ({ result: {}, blob: data, chunkBytes: p.chunkBytes }));
  const res = await a.call("echo", { chunkBytes: 1500 }, { blob, chunkBytes: 4500 });
  assert.deepEqual(res.blob, blob);
  assert.equal(res.tx.chunks, 2);
  assert.equal(res.rx.chunks, 6);
});

test("пустой двоичный блок передаётся как пустой массив", async () => {
  const { a, b } = link();
  b.handle("echo", async (p, data) => ({ result: { got: data.length }, blob: data }));
  const res = await a.call("echo", {}, { blob: new Uint8Array(0) });
  assert.equal(res.result.got, 0);
  assert.equal(res.blob.length, 0);
});

test("ошибка обработчика доходит с кодом и текстом", async () => {
  const { a, b } = link();
  b.handle("fail", async () => {
    const e = new Error("нет документа");
    e.code = "noDocument";
    throw e;
  });
  await assert.rejects(a.call("fail", {}), (err) => {
    assert.equal(err.code, "noDocument");
    assert.equal(err.message, "нет документа");
    return true;
  });
});

test("вызов неизвестного метода отклоняется с кодом noHandler", async () => {
  const { a } = link();
  await assert.rejects(a.call("missing", {}), (err) => err.code === "noHandler");
});

test("события доходят до подписчика", async () => {
  const { a, b } = link();
  const got = new Promise((resolve) => b.on("ready", resolve));
  a.emit("ready", { webgl: true });
  assert.deepEqual(await got, { webgl: true });
});

test("потерянный кусок данных даёт ошибку blobIncomplete, а не испорченные пиксели", async () => {
  let dropped = false;
  const { a, b } = link({ chunkBytes: 3000 }, { blobWaitMs: 30 }, (dir, s) => {
    if (dir === "a>b" && s[0] === "#" && !dropped && s.indexOf(":1:") > 0) {
      dropped = true;
      return false;
    }
    return true;
  });
  b.handle("store", async () => ({ result: {} }));
  await assert.rejects(a.call("store", {}, { blob: randomBytes(10000) }), (err) => err.code === "blobIncomplete");
  assert.equal(dropped, true);
});

test("по каналу идут только строки (ограничение postMessage в UXP)", async () => {
  const types = new Set();
  const { a, b } = link({}, {}, (dir, s) => {
    types.add(typeof s);
    return true;
  });
  b.handle("echo", async (p, data) => ({ result: p, blob: data }));
  b.on("note", () => {});
  a.emit("note", { n: 1 });
  await a.call("echo", { k: "v" }, { blob: randomBytes(100) });
  assert.deepEqual([...types], ["string"]);
});

test("call с timeoutMs отклоняется, если ответа нет", async () => {
  const a = createBridge({ name: "a", post: () => {} });
  await assert.rejects(a.call("anything", {}, { timeoutMs: 20 }), (err) => err.code === "timeout");
});

test("receive молча игнорирует посторонние сообщения", () => {
  const a = createBridge({ name: "a", post: () => {} });
  assert.doesNotThrow(() => {
    a.receive("привет");
    a.receive("");
    a.receive(null);
    a.receive(undefined);
    a.receive(42);
    a.receive({ foo: 1 });
    a.receive("{не json");
    a.receive("#битый-заголовок");
  });
});

test("receive принимает управляющее сообщение, пришедшее уже объектом", async () => {
  // Документация: message проходит через JSON — на всякий случай принимаем и объект.
  let b;
  const a = createBridge({ name: "a", post: (s) => setTimeout(() => b.receive(JSON.parse(s)), 0) });
  b = createBridge({ name: "b", post: (s) => setTimeout(() => a.receive(JSON.parse(s)), 0) });
  b.handle("ping", async () => ({ result: "pong" }));
  const res = await a.call("ping", {});
  assert.equal(res.result, "pong");
});
