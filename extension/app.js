import { dueServers, exportList } from "./model.js";
import { groupOf, groupName } from "./tour.js";
const $ = id => document.getElementById(id);
let state;
let busy = false;
let editingId;
let deletingId;
const date = value => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);

function feedback(text, error = false) {
  $("feedback").textContent = text;
  $("feedback").classList.toggle("error", error);
  $("feedback").hidden = false;
}

async function send(command) {
  const result = await chrome.runtime.sendMessage(command);
  if (!result?.ok) throw new Error(result?.error || "Твинкл пока не отвечает. Закройте и снова откройте расширение.");
  state = result.state;
  render();
  return state;
}

async function act(work) {
  if (busy) return;
  busy = true;
  document.body.setAttribute("aria-busy", "true");
  try { await work(); }
  catch (error) {
    const text = error?.message || "";
    feedback(/[\u0400-\u04ff]/.test(text) ? text : "Не получилось выполнить действие. Проверьте, что расширение включено, и откройте Твинкл заново.", true);
  } finally {
    busy = false;
    document.body.removeAttribute("aria-busy");
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, run) {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", () => act(run));
  return node;
}

function render() {
  if (!state) return;
  const now = Date.now();
  const due = dueServers(state, now);
  $("readyCount").textContent = due.length;
  $("totalCount").textContent = `${state.servers.length} из 19 серверов`;
  $("listCount").textContent = state.servers.length;
  $("mode").textContent = state.enabled ? "Напоминания включены" : "На паузе";
  $("mode").classList.toggle("on", state.enabled);
  $("modeHint").textContent = state.enabled
    ? "Когда придёт время, появится счётчик на значке. Страницы сами не откроются."
    : "Пауза отключает напоминания. Открывать серверы вручную можно в любое время.";
  $("toggle").textContent = state.enabled ? "Поставить на паузу" : "Начать напоминания";
  $("toggle").disabled = !state.servers.length;
  $("openNext").disabled = !due.length;
  $("export").disabled = !state.servers.length;
  $("notifications").textContent = state.notifications ? "Выключить уведомления" : "Включить уведомления";
  $("notificationsHint").textContent = state.notifications
    ? "Уведомим, когда подойдёт время для новых серверов. Windows может скрывать уведомления в режиме «Не беспокоить»."
    : "Без уведомлений останется счётчик на значке расширения.";
  $("empty").hidden = state.servers.length > 0;
  for (const group of ["main", "stalker"]) {
    const servers = state.servers.filter(server => groupOf(server) === group);
    const ready = servers.filter(server => server.dueAt <= now).length;
    $(group + "Count").textContent = `${servers.length} серверов · готовы: ${ready}`;
    $(group + "Start").disabled = !ready;
  }
  $("tourStatus").textContent = state.tour ? `${groupName(state.tour.group)}. ${state.tour.message}` : "Выберите проект. Пройдём серверы по очереди в одной вкладке.";
  $("tourResume").hidden = $("tourStop").hidden = !state.tour?.active;
  const rows = document.createDocumentFragment();
  let lastGroup;
  [...state.servers].sort((a, b) => Number(groupOf(a) === "stalker") - Number(groupOf(b) === "stalker")).forEach((server, index) => {
    const group = groupOf(server);
    if (group !== lastGroup) {
      rows.append(element("h3", "group-heading", groupName(group)));
      lastGroup = group;
    }
    const row = element("article", "server");
    const top = element("div", "server-top");
    top.append(element("div", "server-number", String(index + 1).padStart(2, "0")));
    const info = element("div", "server-info");
    info.append(element("div", "server-name", server.name), element("span", "server-url", server.url));
    top.append(info);
    const tools = element("div", "server-tools");
    tools.append(button("Название", "text-button", () => {
      editingId = server.id;
      $("editName").value = server.name;
      $("editDialog").showModal();
      $("editName").focus();
    }), button("Удалить", "text-button", () => {
      deletingId = server.id;
      $("deleteName").textContent = server.name;
      $("deleteDialog").showModal();
    }));
    top.append(tools);
    row.append(top);
    const ready = server.dueAt <= now;
    const status = ready
      ? server.openedAt !== null ? "Страница открыта. После голосования отметьте результат здесь." : "Пора проверить голосование на WARGM."
      : `Следующее напоминание: ${date(server.dueAt)}.`;
    row.append(element("div", `server-state${ready ? "" : " waiting"}`, status));
    const actions = element("div", "actions");
    actions.append(button("Открыть WARGM", ready ? "primary" : "secondary", async () => {
      await send({ type: "open", id: server.id });
    }));
    if (ready) {
      const mark = button("Я проголосовал", "secondary", async () => {
        await send({ type: "mark", id: server.id });
        feedback("Отметка сохранена. Следующее напоминание через 16 часов. Если ошиблись, нажмите «Отменить отметку».");
      });
      mark.disabled = server.openedAt === null;
      mark.title = server.openedAt === null ? "Сначала откройте страницу сервера" : "Нажмите после подтверждения голоса на WARGM";
      actions.append(mark, button("Через час", "text-button", async () => {
        await send({ type: "later", id: server.id });
        feedback("Отложено на час. Голос не отмечен.");
      }));
    }
    if (server.undo) actions.append(button("Отменить отметку", "text-button", async () => {
      await send({ type: "undo", id: server.id });
      feedback("Отметка отменена. Это не отменяет голос на WARGM.");
    }));
    row.append(actions);
    rows.append(row);
  });
  $("servers").replaceChildren(rows);
  const history = state.history.map(item => {
    const p = element("p");
    p.append(element("time", "", date(item.at)), document.createTextNode(item.text));
    return p;
  });
  $("history").replaceChildren(...(history.length ? history : [element("p", "", "Пока здесь пусто.")]));
  $("clearHistory").disabled = !state.history.length;
}

function focusAdd() {
  $("links").focus();
  $("addPanel").scrollIntoView({ block: "nearest" });
}
for (const group of ["main", "stalker"]) $(group + "Start").addEventListener("click", () => act(() => send({ type: "tour:start", group })));
$("tourResume").addEventListener("click", () => act(() => send({ type: "tour:resume" })));
$("tourStop").addEventListener("click", () => act(() => send({ type: "tour:stop" })));
$("showAdd").addEventListener("click", focusAdd);
$("emptyAdd").addEventListener("click", focusAdd);
$("addForm").addEventListener("submit", event => {
  event.preventDefault();
  act(async () => {
    const before = state.servers.length;
    await send({ type: "add", text: $("links").value });
    $("links").value = "";
    const added = state.servers.length - before;
    feedback(added ? `Добавлено серверов: ${added}. Названия можно изменить в списке.` : "Эти серверы уже есть в списке.");
  });
});
$("toggle").addEventListener("click", () => act(async () => {
  const enabled = !state.enabled;
  await send({ type: "enable", value: enabled });
  feedback(enabled ? "Напоминания включены. Голосование подтверждаете вы на сайте WARGM." : "Напоминания на паузе.");
}));
$("openNext").addEventListener("click", () => act(async () => {
  const next = dueServers(state).find(server => server.openedAt === null) || dueServers(state)[0];
  if (next) await send({ type: "open", id: next.id });
}));
$("notifications").addEventListener("click", () => {
  if (busy || !state) return;
  const enable = !state.notifications;
  const permission = enable ? chrome.permissions.request({ permissions: ["notifications"] }) : Promise.resolve(true);
  act(async () => {
    const granted = await permission;
    if (!granted) {
      feedback("Уведомления не разрешены. Список серверов и счётчик на значке продолжат работать.");
      return;
    }
    await send({ type: "notifications", value: enable });
    if (!enable) await chrome.permissions.remove({ permissions: ["notifications"] });
    feedback(enable ? "Уведомления включены. Напоминания появятся, когда режим напоминаний работает." : "Уведомления выключены.");
  });
});
$("export").addEventListener("click", () => act(async () => {
  const blob = new Blob([JSON.stringify(exportList(state), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "twinkle-servers.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  feedback("Список передан браузеру для сохранения. История и отметки в файл не входят.");
}));
$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", () => act(async () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;
  if (file.size > 32000) throw new Error("Файл слишком большой. Выберите сохранённый список Твинкл.");
  const before = state.servers.length;
  await send({ type: "add", backup: await file.text() });
  feedback(`Добавлено серверов: ${state.servers.length - before}. Уже существующие серверы сохранены.`);
}));
$("editForm").addEventListener("submit", event => {
  event.preventDefault();
  act(async () => {
    await send({ type: "rename", id: editingId, name: $("editName").value });
    $("editDialog").close();
    feedback("Название сохранено.");
  });
});
$("cancelEdit").addEventListener("click", () => $("editDialog").close());
$("cancelDelete").addEventListener("click", () => $("deleteDialog").close());
$("confirmDelete").addEventListener("click", () => act(async () => {
  await send({ type: "remove", id: deletingId });
  $("deleteDialog").close();
  feedback("Сервер удалён из списка.");
}));
$("clearHistory").addEventListener("click", () => act(() => send({ type: "clearHistory" })));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.twinkleState?.newValue) {
    state = changes.twinkleState.newValue;
    render();
  }
});
setInterval(() => {
  if (!document.hidden && !busy && !document.activeElement?.closest("#servers")) render();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) act(() => send({ type: "get" }));
});
act(() => send({ type: "get" }));
