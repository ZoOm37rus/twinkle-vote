import { INTERVAL, addLog } from "./model.js";

export const STALKER_IDS = new Set(["80996", "81003", "81301", "81302"]);
export const groupOf = server => STALKER_IDS.has(server.id) ? "stalker" : "main";
export const groupName = group => group === "stalker" ? "Сталкер" : "Основной проект";
export const voteUrl = server => `${server.url}/votes`;

export function parseCooldown(text) {
  if (typeof text !== "string" || text.length > 80) return null;
  const normalized = text.replace(/\u00a0/g, " ").trim().toLowerCase();
  const match = normalized.match(/^(?:(\d{1,2})\s*ч(?:ас(?:а|ов)?)?\.?\s*)?(\d{1,2})\s*м(?:ин(?:ут(?:а|ы)?)?)?\.?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0), minutes = Number(match[2]);
  const duration = (hours * 60 + minutes) * 60000;
  return minutes <= 60 && duration > 0 && duration <= INTERVAL ? duration : null;
}

export function newTour(state, group, now = Date.now()) {
  if (!["main", "stalker"].includes(group)) throw new Error("Выберите основной проект или Сталкер.");
  const ids = state.servers.filter(server => groupOf(server) === group && server.dueAt <= now).map(server => server.id);
  if (!ids.length) throw new Error("Пока нет серверов, готовых к голосованию. Время следующего напоминания есть в списке.");
  return { id: crypto.randomUUID(), group, ids, index: 0, confirmed: 0, skipped: 0,
    active: true, tabId: null, documentId: null, clickedAt: null, phase: "opening",
    message: "Открываем голосование.", startedAt: now };
}

export function recordCooldown(state, text, now = Date.now()) {
  const duration = parseCooldown(text);
  if (!duration) throw new Error("Не получилось прочитать время WARGM.");
  const tour = state.tour;
  const server = state.servers.find(item => item.id === tour.ids[tour.index]);
  if (!server) throw new Error("Сервер удалён из списка. Начните заново.");
  const confirmed = tour.clickedAt !== null && now - tour.clickedAt >= 0 && now - tour.clickedAt <= 10 * 60000;
  server.undo = { dueAt: server.dueAt, lastVoteAt: server.lastVoteAt };
  server.dueAt = now + duration;
  server.openedAt = null;
  if (confirmed) {
    server.lastVoteAt = now;
    tour.confirmed += 1;
    addLog(state, `После вашего нажатия WARGM показал таймер: ${server.name}.`, now);
  } else {
    tour.skipped += 1;
    addLog(state, `На WARGM уже есть таймер: ${server.name}. Новый голос не записан.`, now);
  }
  tour.clickedAt = null;
  return confirmed;
}
