import { freshState, initializeDefaults, reduceState, dueServers, reminderKey, addLog } from "./model.js";
import { newTour, voteUrl, recordCooldown } from "./tour.js";

const KEY = "twinkleState";
const ALARM = "twinkle-reminder";
const NOTICE = "twinkle-ready";
let queue = Promise.resolve();

function serial(work) {
  const next = queue.then(work);
  queue = next.catch(() => {});
  return next;
}

async function read() {
  const data = await chrome.storage.local.get(KEY);
  const previous = data[KEY] || freshState();
  if (previous.version !== 1 || !Array.isArray(previous.servers) || !Array.isArray(previous.history)) {
    throw new Error("Не получилось прочитать настройки. Сохранённые данные не удалены. Попробуйте перезапустить браузер.");
  }
  const state = initializeDefaults(previous);
  if (state !== previous) await save(state);
  return state;
}

async function save(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

function pageServer(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://wargm.ru" ? parsed.pathname.match(/^\/server\/([1-9]\d*)\/votes\/?$/)?.[1] : null;
  } catch { return null; }
}

function tourView(tour) {
  if (!tour) return null;
  return { id: tour.id, active: tour.active, index: tour.index, total: tour.ids.length,
    confirmed: tour.confirmed, skipped: tour.skipped, message: tour.message, phase: tour.phase };
}

async function navigateTour(state, expectedId = null) {
  const tour = state.tour;
  try {
    if (expectedId) {
      const tab = await chrome.tabs.get(tour.tabId);
      if (pageServer(tab.url) !== expectedId || (tab.pendingUrl && pageServer(tab.pendingUrl) !== expectedId)) {
        throw new Error("left");
      }
    }
    if (tour.index >= tour.ids.length) {
      tour.active = false;
      tour.phase = "done";
      tour.message = `Готово. Голосов с таймером: ${tour.confirmed}. Пропущено: ${tour.skipped}.`;
      await save(state);
      await chrome.tabs.update(tour.tabId, { url: chrome.runtime.getURL("index.html#tour-finished") });
      return;
    }
    const server = state.servers.find(item => item.id === tour.ids[tour.index]);
    if (!server) throw new Error("missing");
    tour.phase = "opening";
    tour.documentId = null;
    tour.clickedAt = null;
    tour.message = `Сервер ${tour.index + 1} из ${tour.ids.length}. Открываем голосование.`;
    await save(state);
    await chrome.tabs.update(tour.tabId, { url: voteUrl(server) });
  } catch {
    tour.phase = "paused";
    tour.message = "Переход остановлен. Нажмите «Продолжить» в Твинкл, когда будете готовы.";
    await save(state);
  }
}

async function handleTourControl(state, message) {
  if (message.type === "tour:stop") {
    if (state.tour) {
      state.tour.active = false;
      state.tour.phase = "stopped";
      state.tour.clickedAt = null;
      state.tour.message = "Проход остановлен. Сохранённые результаты остались в списке.";
      await save(state);
    }
    return state;
  }
  if (message.type === "tour:start") {
    if (state.tour?.active && state.tour.group === message.group) {
      return handleTourControl(state, { type: "tour:resume" });
    }
    state.tour = newTour(state, message.group);
    await save(state);
  } else if (message.type !== "tour:resume" || !state.tour?.active) {
    throw new Error("Сначала выберите проект.");
  }
  const tour = state.tour;
  if (message.type === "tour:resume" && tour.phase !== "paused") {
    try {
      const tab = await chrome.tabs.get(tour.tabId);
      if (pageServer(tab.url) === tour.ids[tour.index]) {
        await chrome.tabs.update(tour.tabId, { active: true });
        return state;
      }
    } catch {}
  }
  try {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    tour.tabId = tab.id;
  } catch {
    tour.phase = "paused";
    tour.message = "Не получилось открыть вкладку. Нажмите «Продолжить», чтобы попробовать снова.";
    await save(state);
    throw new Error(tour.message);
  }
  await navigateTour(state);
  return state;
}

async function handleTourPage(message, sender) {
  const state = await read();
  const tour = state.tour;
  const serverId = pageServer(sender.url);
  if (!tour?.active || tour.phase === "paused" || sender.frameId !== 0
      || sender.tab?.id !== tour.tabId || !serverId || serverId !== tour.ids[tour.index]
      || !sender.documentId || (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
    return { tour: null };
  }
  if (message.type === "tour:hello") {
    if (tour.documentId !== sender.documentId) {
      tour.documentId = sender.documentId;
      tour.phase = "waiting";
      tour.message = "Ждём страницу WARGM.";
      await save(state);
    }
    return { tour: tourView(tour) };
  }
  if (message.tourId !== tour.id || tour.documentId !== sender.documentId) return { tour: null };
  if (message.type === "tour:clicked") {
    if (["ready", "activation", "waiting", "unknown"].includes(tour.phase)) {
      tour.clickedAt = Date.now();
      tour.phase = "voting";
      tour.message = "Ждём обновления страницы и таймера WARGM.";
      await save(state);
    }
  } else if (message.type === "tour:observe") {
    if (message.status === "cooldown") {
      recordCooldown(state, message.timer);
      tour.index += 1;
      tour.documentId = null;
      await save(state);
      await reconcile(state);
      await navigateTour(state, serverId);
    } else {
      const hints = {
        ready: "Нажмите «ГОЛОСОВАТЬ» на WARGM. Дальше перейдём сами.",
        activation: "WARGM готовит кнопку. Дождитесь надписи «ГОЛОСОВАТЬ».",
        login: "Войдите в WARGM. Затем вернитесь на эту страницу голосования.",
        unknown: "Ждём кнопку или таймер WARGM. Если сайт просит проверку, пройдите её самостоятельно."
      };
      if (hints[message.status] && tour.phase !== "voting"
          && (tour.message !== hints[message.status] || tour.phase !== message.status)) {
        tour.phase = message.status;
        tour.message = hints[message.status];
        await save(state);
      }
      if (tour.phase === "voting" && Date.now() - tour.clickedAt > 10 * 60000) {
        tour.clickedAt = null;
        tour.phase = "waiting";
        tour.message = "Таймер пока не появился. Голос не отмечен. Можно повторить попытку на сайте или пропустить сервер.";
        await save(state);
      }
    }
  } else if (message.type === "tour:skip") {
    tour.skipped += 1;
    tour.index += 1;
    tour.clickedAt = null;
    tour.documentId = null;
    addLog(state, "Сервер пропущен по вашему нажатию. Голос не записан.", Date.now());
    await save(state);
    await navigateTour(state, serverId);
  } else if (message.type === "tour:pageStop") {
    await handleTourControl(state, { type: "tour:stop" });
  }
  return { tour: tourView(tour) };
}

async function reconcile(state, notify = false) {
  const now = Date.now();
  const due = dueServers(state, now);
  await chrome.action.setBadgeBackgroundColor({ color: "#425766" });
  await chrome.action.setBadgeText({ text: state.enabled && due.length ? String(due.length) : "" });
  await chrome.action.setTitle({ title: state.enabled ? `Твинкл: ждут отметки ${due.length}` : "Твинкл: напоминания на паузе" });
  if (!state.enabled || !due.length || state.snoozeUntil > now) await chrome.notifications?.clear(NOTICE).catch(() => {});
  const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
  const key = reminderKey(state, now);
  const alreadyNotified = new Set(state.notifiedKey.split("|").filter(Boolean));
  const hasNewDue = key.split("|").filter(Boolean).some(item => !alreadyNotified.has(item));
  if (notify && state.enabled && state.notifications && granted && due.length
      && state.snoozeUntil <= now && hasNewDue) {
    try {
      await chrome.notifications.create(NOTICE, {
        type: "basic", iconUrl: "icons/128.png",
        title: "Твинкл: пора проверить голосование",
        message: `Ждут вашей отметки: ${due.length}. Откройте список и проголосуйте на WARGM.`,
        buttons: [{ title: "Открыть список" }, { title: "Через час" }]
      });
      state.notifiedKey = key;
      await save(state);
    } catch {
      state.notifications = false;
      addLog(state, "Уведомление не показано. Проверьте разрешения уведомлений в браузере и Windows.", now);
      await save(state);
    }
  }
  if (!state.enabled) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  const future = state.servers.map(item => item.dueAt).filter(time => time > now);
  if (state.snoozeUntil > now) future.push(state.snoozeUntil);
  if (state.notifications && granted && due.length && hasNewDue && state.snoozeUntil <= now) {
    future.push(now + 60000);
  }
  const when = Math.max(now + 60000, Math.min(...future, now + 60 * 60 * 1000));
  await chrome.alarms.create(ALARM, { when });
}

async function handle(message) {
  let state = await read();
  if (message.type === "get") return state;
  if (["tour:start", "tour:resume", "tour:stop"].includes(message.type)) return handleTourControl(state, message);
  if (message.type === "open") {
    const server = state.servers.find(item => item.id === message.id);
    if (!server) throw new Error("Этот сервер уже удалён из списка.");
    try { await chrome.tabs.create({ url: server.url, active: true }); }
    catch { throw new Error("Не получилось открыть страницу. Попробуйте ещё раз."); }
    state = reduceState(state, { type: "opened", id: server.id });
  } else {
    const allowed = ["add", "enable", "notifications", "mark", "undo", "later", "rename", "remove", "snooze", "clearHistory"];
    if (!allowed.includes(message.type)) throw new Error("Неизвестное действие. Откройте Твинкл заново.");
    if (message.type === "notifications" && message.value) {
      if (!await chrome.permissions.contains({ permissions: ["notifications"] })) {
        throw new Error("Сначала разрешите уведомления в браузере.");
      }
    }
    state = reduceState(state, message);
    if (state.tour?.active && ["remove", "mark", "undo", "later"].includes(message.type)) {
      await handleTourControl(state, { type: "tour:stop" });
    }
  }
  await save(state);
  await reconcile(state, false);
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
  if (["tour:hello", "tour:clicked", "tour:observe", "tour:skip", "tour:pageStop"].includes(message.type)) {
    serial(() => handleTourPage(message, sender)).then(
      result => respond({ ok: true, ...result }),
      () => respond({ ok: false, error: "Не получилось проверить результат. Голос не отмечен. Откройте Твинкл и продолжите." })
    );
    return true;
  }
  const senderPage = sender.url?.split("#")[0];
  if (![chrome.runtime.getURL("index.html"), chrome.runtime.getURL("popup.html")].includes(senderPage)) return false;
  serial(() => handle(message)).then(
    state => respond({ ok: true, state }),
    error => respond({ ok: false, error: error instanceof Error ? error.message : "Не получилось сохранить изменения. Попробуйте ещё раз." })
  );
  return true;
});

const refresh = () => serial(async () => reconcile(await read(), true));
const reportBackgroundError = () => {
  chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  chrome.action.setTitle({ title: "Твинкл: откройте список и проверьте настройки" }).catch(() => {});
};
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) refresh().catch(reportBackgroundError);
});
chrome.runtime.onInstalled.addListener(() => refresh().catch(reportBackgroundError));
chrome.runtime.onStartup.addListener(() => serial(async () => {
  const state = await read();
  if (state.tour?.active) {
    state.tour.phase = "paused";
    state.tour.clickedAt = null;
    state.tour.message = "Браузер был закрыт. Нажмите «Продолжить», чтобы вернуться к голосованию.";
    await save(state);
  }
  await reconcile(state, true);
}).catch(reportBackgroundError));
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const state = await read();
  if (state.tour?.active && state.tour.tabId === tabId) {
    state.tour.phase = "paused";
    state.tour.clickedAt = null;
    state.tour.message = "Вкладка закрыта. Нажмите «Продолжить», чтобы вернуться к голосованию.";
    await save(state);
  }
}).catch(reportBackgroundError));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage().catch(reportBackgroundError));
chrome.notifications?.onClicked.addListener(id => {
  if (id === NOTICE) chrome.runtime.openOptionsPage().catch(reportBackgroundError);
});
chrome.notifications?.onButtonClicked.addListener((id, button) => {
  if (id !== NOTICE) return;
  if (button === 0) chrome.runtime.openOptionsPage().catch(reportBackgroundError);
  if (button === 1) serial(() => handle({ type: "snooze" })).catch(reportBackgroundError);
});
chrome.permissions.onRemoved.addListener(() => serial(async () => {
  const state = await read();
  if (!await chrome.permissions.contains({ permissions: ["notifications"] })) {
    state.notifications = false;
    await save(state);
  }
  await reconcile(state);
}).catch(reportBackgroundError));

serial(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const state = await read();
  await reconcile(state, false);
}).catch(reportBackgroundError);
