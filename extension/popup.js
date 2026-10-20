import { groupOf, groupName } from "./tour.js";
const $ = id => document.getElementById(id);
let busy = false;
async function run(message, close = false) {
  if (busy) return;
  busy = true;
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error);
    const state = reply.state;
    for (const group of ["main", "stalker"]) {
      const servers = state.servers.filter(server => groupOf(server) === group);
      const due = servers.filter(server => server.dueAt <= Date.now()).length;
      $(group + "Count").textContent = `${servers.length} серверов · готовы: ${due}`;
      $(group).disabled = !due;
    }
    const tour = state.tour;
    $("resume").hidden = $("stop").hidden = !tour?.active;
    $("status").textContent = tour ? `${groupName(tour.group)}. ${tour.message}` : "";
    if (close) window.close();
  } catch (error) {
    $("status").textContent = error?.message || "Не получилось открыть голосование. Попробуйте ещё раз.";
  } finally { busy = false; }
}
for (const group of ["main", "stalker"]) $(group).onclick = () => run({ type: "tour:start", group }, true);
$("resume").onclick = () => run({ type: "tour:resume" }, true);
$("stop").onclick = () => run({ type: "tour:stop" });
$("settings").onclick = () => chrome.runtime.openOptionsPage();
run({ type: "get" });
