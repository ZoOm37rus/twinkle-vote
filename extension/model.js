import { DEFAULT_SERVERS } from "./default-servers.js";

export const INTERVAL = 16 * 60 * 60 * 1000;
export const MAX_SERVERS = 19;
export const SNOOZE = 60 * 60 * 1000;

export function freshState() {
  return { version: 1, enabled: false, notifications: false, snoozeUntil: 0,
    notifiedKey: "", servers: [], history: [] };
}

export function initializeDefaults(original, now = Date.now()) {
  if (original.defaultServersVersion === 1) return original;
  const known = new Set(original.servers.map(server => canonicalUrl(server.url)));
  const additions = DEFAULT_SERVERS.filter(server => !known.has(server.url))
    .slice(0, Math.max(0, MAX_SERVERS - original.servers.length));
  const state = additions.length ? reduceState(original, {
    type: "add",
    backup: JSON.stringify({ format: "twinkle-vote-servers", version: 1, servers: additions })
  }, now) : structuredClone(original);
  state.defaultServersVersion = 1;
  return state;
}

export function canonicalUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); }
  catch { throw new Error("Не получилось прочитать ссылку. Скопируйте адрес страницы сервера WARGM."); }
  if (url.protocol !== "https:" || !["wargm.ru", "www.wargm.ru"].includes(url.hostname)
      || url.port || url.username || url.password) {
    throw new Error("Нужна ссылка на сервер с сайта https://wargm.ru.");
  }
  const match = url.pathname.match(/^\/server\/([1-9]\d{0,11})(?:\/(?:votes?|stats|shop))?\/?$/);
  if (!match) throw new Error("Откройте страницу сервера WARGM и скопируйте её адрес. Пример: https://wargm.ru/server/12345");
  return `https://wargm.ru/server/${match[1]}`;
}

export function cleanName(input, url) {
  const name = String(input ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length > 70) throw new Error("Название слишком длинное. Оставьте не больше 70 символов.");
  return name || `Сервер ${url.split("/").pop()}`;
}

export function parseLines(value) {
  if (typeof value !== "string" || value.length > 12000) throw new Error("Слишком много текста. Добавляйте до 19 серверов за раз.");
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Вставьте хотя бы одну ссылку на сервер.");
  if (lines.length > MAX_SERVERS) throw new Error("В списке может быть до 19 серверов.");
  return lines.map((line, index) => {
    try {
      const parts = line.split("|");
      if (parts.length > 2) throw new Error("Используйте формат: название | ссылка.");
      const url = canonicalUrl(parts.length === 2 ? parts[1] : parts[0]);
      return { url, name: cleanName(parts.length === 2 ? parts[0] : "", url) };
    } catch (error) { throw new Error(`Строка ${index + 1}. ${error.message}`); }
  });
}

export function parseBackup(text) {
  let data;
  if (typeof text !== "string" || text.length > 32000) throw new Error("Файл слишком большой. Выберите сохранённый список Твинкл.");
  try { data = JSON.parse(text); }
  catch { throw new Error("Не получилось прочитать файл. Выберите сохранённый список Твинкл."); }
  if (data?.format !== "twinkle-vote-servers" || data.version !== 1
      || !Array.isArray(data.servers) || !data.servers.length || data.servers.length > MAX_SERVERS) {
    throw new Error("Этот файл не похож на список серверов Твинкл.");
  }
  return data.servers.map(item => {
    if (!item || typeof item.url !== "string" || typeof item.name !== "string") {
      throw new Error("В файле есть сервер без названия или ссылки.");
    }
    const url = canonicalUrl(item.url);
    return { url, name: cleanName(item.name, url) };
  });
}

export function dueServers(state, now = Date.now()) {
  return state.servers.filter(server => server.dueAt <= now);
}

export function reminderKey(state, now) {
  return dueServers(state, now).map(server => `${server.id}:${server.dueAt}`).sort().join("|");
}

export function addLog(state, text, now) {
  state.history.unshift({ at: now, text });
  state.history = state.history.slice(0, 80);
}

export function reduceState(original, command, now = Date.now()) {
  const state = structuredClone(original);
  const server = state.servers.find(item => item.id === command.id);
  const requireServer = () => {
    if (!server) throw new Error("Сервер уже удалён. Обновите список и попробуйте ещё раз.");
  };
  switch (command.type) {
    case "add": {
      const entries = command.backup !== undefined ? parseBackup(command.backup) : parseLines(command.text);
      const known = new Set(state.servers.map(item => item.url));
      const additions = entries.filter(item => {
        if (known.has(item.url)) return false;
        known.add(item.url);
        return true;
      });
      if (state.servers.length + additions.length > MAX_SERVERS) throw new Error("В списке уже почти 19 серверов. Удалите ненужные или добавьте меньше ссылок.");
      for (const item of additions) {
        state.servers.push({ ...item, id: item.url.split("/").pop(), dueAt: 0,
          lastVoteAt: null, openedAt: null, undo: null });
      }
      if (additions.length) addLog(state, `Добавлено серверов: ${additions.length}.`, now);
      break;
    }
    case "enable":
      if (typeof command.value !== "boolean") throw new Error("Не получилось изменить настройку.");
      if (command.value && !state.servers.length) throw new Error("Сначала добавьте хотя бы один сервер.");
      state.enabled = command.value;
      state.snoozeUntil = 0;
      state.notifiedKey = "";
      addLog(state, state.enabled ? "Напоминания включены." : "Напоминания на паузе.", now);
      break;
    case "notifications":
      state.notifications = command.value === true;
      state.notifiedKey = "";
      break;
    case "opened":
      requireServer();
      server.openedAt = now;
      break;
    case "mark":
      requireServer();
      if (server.openedAt === null || server.dueAt > now) throw new Error("Сначала откройте страницу сервера. Отмечайте голос только после подтверждения на WARGM.");
      server.undo = { dueAt: server.dueAt, lastVoteAt: server.lastVoteAt };
      server.lastVoteAt = now;
      server.dueAt = now + INTERVAL;
      server.openedAt = null;
      addLog(state, `Вы отметили голос: ${server.name}.`, now);
      break;
    case "undo":
      requireServer();
      if (!server.undo) throw new Error("Эту отметку уже нельзя отменить.");
      server.dueAt = server.undo.dueAt;
      server.lastVoteAt = server.undo.lastVoteAt;
      server.undo = null;
      server.openedAt = null;
      addLog(state, `Отметка отменена: ${server.name}.`, now);
      state.notifiedKey = "";
      break;
    case "later":
      requireServer();
      server.dueAt = now + SNOOZE;
      server.openedAt = null;
      server.undo = null;
      addLog(state, `Отложено на час: ${server.name}.`, now);
      break;
    case "rename":
      requireServer();
      server.name = cleanName(command.name, server.url);
      break;
    case "remove":
      requireServer();
      state.servers = state.servers.filter(item => item.id !== server.id);
      addLog(state, `Удалён сервер: ${server.name}.`, now);
      if (!state.servers.length) state.enabled = false;
      break;
    case "snooze":
      state.snoozeUntil = now + SNOOZE;
      state.notifiedKey = "";
      break;
    case "clearHistory":
      state.history = [];
      break;
    default:
      throw new Error("Не получилось выполнить действие. Закройте и снова откройте Твинкл.");
  }
  return state;
}

export function exportList(state) {
  return { format: "twinkle-vote-servers", version: 1,
    servers: state.servers.map(({ name, url }) => ({ name, url })) };
}
