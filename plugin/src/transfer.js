"use strict";
/*
 * Wrap 3D — обмен между UXP и WebView.
 *
 * Один и тот же файл работает на обеих сторонах: в UXP подключается через require,
 * в WebView попадает в сборку app.js.
 *
 * По документации Adobe сообщение postMessage проходит через JSON, а параметр transfer
 * не работает, поэтому ArrayBuffer напрямую не передать. Всё, что идёт по каналу, — строки:
 *   "{...}"                                    управляющее сообщение (JSON)
 *   "#id:index:total:offset:byteLength:t0:…"   кусок двоичных данных в base64
 */

var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var ENC = new Uint8Array(64);
var DEC = new Uint8Array(256);
(function () {
  for (var i = 0; i < 64; i++) {
    ENC[i] = ALPHABET.charCodeAt(i);
    DEC[ALPHABET.charCodeAt(i)] = i;
  }
})();

var DEFAULT_CHUNK_BYTES = 3 * 1024 * 1024;
var DEFAULT_BLOB_WAIT_MS = 5000;

var textDecoder = null;
try {
  if (typeof TextDecoder === "function") textDecoder = new TextDecoder("utf-8");
} catch (e) {
  textDecoder = null;
}

function asciiToString(codes) {
  if (textDecoder) return textDecoder.decode(codes);
  var s = "";
  var STEP = 0x8000;
  for (var i = 0; i < codes.length; i += STEP) {
    s += String.fromCharCode.apply(null, codes.subarray(i, Math.min(i + STEP, codes.length)));
  }
  return s;
}

/** Кодирует bytes[start, end) в base64. */
function base64Encode(bytes, start, end) {
  start = start || 0;
  if (end === undefined) end = bytes.length;
  var len = end - start;
  var rem = len % 3;
  var fullEnd = end - rem;
  var out = new Uint8Array(Math.ceil(len / 3) * 4);
  var o = 0;
  var i = start;
  var n;
  for (; i < fullEnd; i += 3) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = ENC[n >>> 18];
    out[o++] = ENC[(n >>> 12) & 63];
    out[o++] = ENC[(n >>> 6) & 63];
    out[o++] = ENC[n & 63];
  }
  if (rem === 1) {
    n = bytes[i] << 16;
    out[o++] = ENC[n >>> 18];
    out[o++] = ENC[(n >>> 12) & 63];
    out[o++] = 61;
    out[o++] = 61;
  } else if (rem === 2) {
    n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = ENC[n >>> 18];
    out[o++] = ENC[(n >>> 12) & 63];
    out[o++] = ENC[(n >>> 6) & 63];
    out[o++] = 61;
  }
  return asciiToString(out);
}

/**
 * Декодирует base64 из str, начиная с позиции strStart и до конца строки,
 * в dest по смещению destOffset. Возвращает число записанных байт.
 */
function base64DecodeInto(str, strStart, dest, destOffset) {
  var end = str.length;
  var len = end - strStart;
  if (len === 0) return 0;
  if (len % 4 !== 0) throw new Error("base64: длина не кратна 4");
  var pad = 0;
  if (str.charCodeAt(end - 1) === 61) {
    pad = str.charCodeAt(end - 2) === 61 ? 2 : 1;
  }
  var outLen = (len / 4) * 3 - pad;
  if (destOffset + outLen > dest.length) throw new Error("base64: данные не помещаются в буфер");
  var fullEnd = pad ? end - 4 : end;
  var o = destOffset;
  var i = strStart;
  var n;
  for (; i < fullEnd; i += 4) {
    n =
      (DEC[str.charCodeAt(i) & 255] << 18) |
      (DEC[str.charCodeAt(i + 1) & 255] << 12) |
      (DEC[str.charCodeAt(i + 2) & 255] << 6) |
      DEC[str.charCodeAt(i + 3) & 255];
    dest[o++] = n >>> 16;
    dest[o++] = (n >>> 8) & 255;
    dest[o++] = n & 255;
  }
  if (pad === 1) {
    n =
      (DEC[str.charCodeAt(i) & 255] << 18) |
      (DEC[str.charCodeAt(i + 1) & 255] << 12) |
      (DEC[str.charCodeAt(i + 2) & 255] << 6);
    dest[o++] = n >>> 16;
    dest[o++] = (n >>> 8) & 255;
  } else if (pad === 2) {
    n = (DEC[str.charCodeAt(i) & 255] << 18) | (DEC[str.charCodeAt(i + 1) & 255] << 12);
    dest[o++] = n >>> 16;
  }
  return outLen;
}

function makeError(code, message, detail) {
  var err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function tick() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** Размер куска должен делиться на 3, чтобы каждый кусок кодировался в base64 независимо. */
function normalizeChunk(bytes) {
  var n = Math.floor(Number(bytes) || DEFAULT_CHUNK_BYTES);
  if (n < 3) n = 3;
  return n - (n % 3);
}

/**
 * Мост запрос/ответ поверх канала строк.
 *   opts.post(string)   отправка строки другой стороне
 *   opts.name           имя стороны, для журнала
 *   opts.chunkBytes     размер куска двоичных данных по умолчанию
 *   opts.blobWaitMs     сколько ждать недостающие куски перед ошибкой
 *   opts.log(level, text)
 */
function createBridge(opts) {
  var post = opts.post;
  var name = opts.name || "bridge";
  var log = opts.log || function () {};
  var defaultChunk = normalizeChunk(opts.chunkBytes);
  var blobWaitMs = opts.blobWaitMs === undefined ? DEFAULT_BLOB_WAIT_MS : opts.blobWaitMs;

  var seq = 1;
  var pending = new Map(); // id вызова -> { resolve, reject, tx, started, timer }
  var handlers = {}; // метод -> функция
  var listeners = {}; // событие -> [функции]
  var incoming = new Map(); // id блока -> { data, total, got, t0, decodeMs, doneAt }

  function sendJson(obj) {
    post(JSON.stringify(obj));
  }

  async function sendBlob(bytes, chunkBytes) {
    var chunk = chunkBytes ? normalizeChunk(chunkBytes) : defaultChunk;
    var id = name + "-" + seq++;
    var total = Math.max(1, Math.ceil(bytes.length / chunk));
    var t0 = Date.now();
    var encodeMs = 0;
    var postMs = 0;
    for (var k = 0; k < total; k++) {
      var from = k * chunk;
      var to = Math.min(bytes.length, from + chunk);
      var te = Date.now();
      var text = base64Encode(bytes, from, to);
      var tp = Date.now();
      encodeMs += tp - te;
      post("#" + id + ":" + k + ":" + total + ":" + from + ":" + bytes.length + ":" + t0 + ":" + text);
      postMs += Date.now() - tp;
      if (k < total - 1) await tick();
    }
    return { id: id, bytes: bytes.length, chunks: total, encodeMs: encodeMs, postMs: postMs };
  }

  function receiveChunk(str) {
    // "#id:index:total:offset:byteLength:t0:" + base64
    var fields = [];
    var pos = 1;
    for (var f = 0; f < 6; f++) {
      var colon = str.indexOf(":", pos);
      if (colon < 0) {
        log("warn", "кусок данных с битым заголовком: " + str.slice(0, 60));
        return;
      }
      fields.push(str.slice(pos, colon));
      pos = colon + 1;
    }
    var id = fields[0];
    var total = Number(fields[2]);
    var offset = Number(fields[3]);
    var byteLength = Number(fields[4]);
    var t0 = Number(fields[5]);
    if (!(total >= 1) || !(offset >= 0) || !(byteLength >= 0)) {
      log("warn", "кусок данных с неверными числами в заголовке: " + str.slice(0, 60));
      return;
    }
    var rec = incoming.get(id);
    if (!rec) {
      rec = { data: new Uint8Array(byteLength), total: total, got: 0, t0: t0, decodeMs: 0, doneAt: 0 };
      incoming.set(id, rec);
    }
    var td = Date.now();
    try {
      base64DecodeInto(str, pos, rec.data, offset);
    } catch (e) {
      log("error", "не удалось разобрать кусок данных " + id + ": " + e.message);
      return;
    }
    rec.decodeMs += Date.now() - td;
    rec.got++;
    if (rec.got >= rec.total) rec.doneAt = Date.now();
  }

  /** Забирает собранный блок; недостающие куски ждёт не дольше blobWaitMs. */
  async function takeBlob(id) {
    var deadline = Date.now() + blobWaitMs;
    for (;;) {
      var rec = incoming.get(id);
      if (rec && rec.got >= rec.total) {
        incoming.delete(id);
        return {
          data: rec.data,
          stats: { bytes: rec.data.length, chunks: rec.total, ms: rec.doneAt - rec.t0, decodeMs: rec.decodeMs },
        };
      }
      if (Date.now() >= deadline) {
        incoming.delete(id);
        throw makeError(
          "blobIncomplete",
          "двоичные данные пришли не полностью: " + (rec ? rec.got + " из " + rec.total + " кусков" : "ни одного куска"),
        );
      }
      await sleep(5);
    }
  }

  async function handleRequest(msg) {
    var res = { t: "res", id: msg.id, ok: true };
    try {
      var blob = null;
      if (msg.b) {
        var taken = await takeBlob(msg.b);
        blob = taken.data;
        res.rx = taken.stats;
      }
      var handler = handlers[msg.m];
      if (!handler) throw makeError("noHandler", "неизвестный метод: " + msg.m);
      var out = (await handler(msg.p || {}, blob)) || {};
      res.r = out.result;
      if (out.blob) {
        var tx = await sendBlob(out.blob, out.chunkBytes);
        res.b = tx.id;
        res.tx = tx;
      }
    } catch (e) {
      res.ok = false;
      delete res.b;
      res.e = {
        code: (e && e.code) || "error",
        message: String((e && e.message) || e),
        detail: e && e.detail,
      };
    }
    sendJson(res);
  }

  async function handleResponse(msg) {
    var p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (!msg.ok) {
      var e = msg.e || {};
      p.reject(makeError(e.code || "error", e.message || "ошибка", e.detail));
      return;
    }
    try {
      var blob = null;
      var rx = null;
      if (msg.b) {
        var taken = await takeBlob(msg.b);
        blob = taken.data;
        rx = taken.stats;
      }
      p.resolve({
        result: msg.r,
        blob: blob,
        tx: p.tx, // отправка наших данных
        peerRx: msg.rx || null, // как их принял собеседник
        peerTx: msg.tx || null, // как собеседник отправлял ответ
        rx: rx, // как мы приняли данные ответа
        ms: Date.now() - p.started,
      });
    } catch (err) {
      p.reject(err);
    }
  }

  function handleControl(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "req") {
      handleRequest(msg);
    } else if (msg.t === "res") {
      handleResponse(msg);
    } else if (msg.t === "evt") {
      var list = listeners[msg.m] || [];
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](msg.p);
        } catch (e) {
          log("error", "ошибка в обработчике события " + msg.m + ": " + (e && e.message));
        }
      }
    }
  }

  /** Вход для всего, что пришло по каналу. */
  function receive(data) {
    if (typeof data === "string") {
      if (data.length === 0) return;
      var first = data.charCodeAt(0);
      if (first === 35 /* # */) {
        receiveChunk(data);
      } else if (first === 123 /* { */) {
        var msg;
        try {
          msg = JSON.parse(data);
        } catch (e) {
          return;
        }
        handleControl(msg);
      }
      return;
    }
    if (data && typeof data === "object") handleControl(data);
  }

  /**
   * Вызов метода на другой стороне.
   *   o.blob        Uint8Array, который нужно передать вместе с запросом
   *   o.chunkBytes  размер куска для этого вызова
   *   o.timeoutMs   предел ожидания ответа
   */
  function call(method, params, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var id = seq++;
      var entry = { resolve: resolve, reject: reject, tx: null, started: Date.now(), timer: null };
      pending.set(id, entry);
      if (o.timeoutMs) {
        entry.timer = setTimeout(function () {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(makeError("timeout", "нет ответа на «" + method + "» за " + o.timeoutMs + " мс"));
        }, o.timeoutMs);
      }
      (async function () {
        try {
          var req = { t: "req", id: id, m: method, p: params || {} };
          if (o.blob) {
            entry.tx = await sendBlob(o.blob, o.chunkBytes);
            req.b = entry.tx.id;
          }
          sendJson(req);
        } catch (e) {
          if (entry.timer) clearTimeout(entry.timer);
          pending.delete(id);
          reject(e);
        }
      })();
    });
  }

  function handle(method, fn) {
    handlers[method] = fn;
  }

  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
  }

  function emit(event, payload) {
    sendJson({ t: "evt", m: event, p: payload });
  }

  return { call: call, handle: handle, on: on, emit: emit, receive: receive };
}

module.exports = {
  base64Encode: base64Encode,
  base64DecodeInto: base64DecodeInto,
  createBridge: createBridge,
  makeError: makeError,
  DEFAULT_CHUNK_BYTES: DEFAULT_CHUNK_BYTES,
};
