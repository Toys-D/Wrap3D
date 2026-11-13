// Очередь журнала: записи, сделанные до появления связи с UXP, не теряются,
// а уходят в консоль UXP, как только связь есть.

/**
 * trySend(entry) возвращает true, если запись отправлена. Ложное значение или исключение
 * означают «пока нельзя» — запись остаётся в очереди.
 */
export function createLogQueue(trySend, limit = 300) {
  const items = [];

  function flush() {
    while (items.length) {
      let sent = false;
      try {
        sent = !!trySend(items[0]);
      } catch (e) {
        sent = false;
      }
      if (!sent) return;
      items.shift();
    }
  }

  function push(entry) {
    items.push(entry);
    if (items.length > limit) items.shift();
    flush();
  }

  return { push, flush };
}
