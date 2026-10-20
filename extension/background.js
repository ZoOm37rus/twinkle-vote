import { freshState, reduceState, dueServers, reminderKey, addLog } from "./model.js";

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
  if (!data[KEY]) return freshState();
  if (data[KEY].version !== 1 || !Array.isArray(data[KEY].servers) || !Array.isArray(data[KEY].history)) {
    throw new Error("Не получилось прочитать настройки. Сохранённые данные не удалены. Попробуйте перезапустить браузер.");
  }
  return data[KEY];
}

async function save(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

async function reconcile(state, notify = false) {
  const now = Date.now();
  const due = dueServers(state, now);
  await chrome.action.setBadgeBackgroundColor({ color: "#8067E8" });
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
  }
  await save(state);
  await reconcile(state, false);
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("index.html")) return false;
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
chrome.runtime.onStartup.addListener(() => refresh().catch(reportBackgroundError));
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
