import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
await mkdir(path.join(root, ".tools"), { recursive: true });
const profile = await mkdtemp(path.join(root, ".tools", "browser-test-"));
const launch = () => chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 1000 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
let context = await launch();
const errors = [];
const reports = [];
let page;
try {
  await context.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).hostname === "wargm.ru") {
      return route.fulfill({ contentType: "text/html",
        body: "<!doctype html><html lang='ru'><meta charset='utf-8'><title>Локальная заглушка WARGM</title><p>Тест открытия страницы. Запрос на WARGM не отправлен.</p></html>" });
    }
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    self.testOpenedTabs = [];
    chrome.tabs.create = async options => {
      const tab = await create({ ...options, url: "about:blank" });
      self.testOpenedTabs.push({ requested: options, id: tab.id });
      return tab;
    };
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".server").length === 19);
  const defaults = await page.evaluate(async () => (await chrome.storage.local.get("twinkleState")).twinkleState);
  assert.equal(new Set(defaults.servers.map(server => server.url)).size, 19);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.defaultServersVersion, 1);
  await page.screenshot({ path: path.join(results, "00-default-servers.png"), fullPage: true });
  for (const server of defaults.servers) {
    const reply = await page.evaluate(id => chrome.runtime.sendMessage({ type: "remove", id }), server.id);
    assert.equal(reply.ok, true);
  }
  await page.reload();
  reports.push("Fresh installation contains 19 Twinkle Play servers; removing them and reloading does not restore them.");
  await page.waitForFunction(() => document.getElementById("toggle").disabled);
  assert.equal(await page.locator("#empty").isVisible(), true);
  assert.equal(await page.locator("#feedback").isVisible(), false);
  await page.screenshot({ path: path.join(results, "01-empty.png"), fullPage: true });
  reports.push("Extension loaded in real Chromium with an empty initial state.");

  await page.locator("#links").fill("Демонстрационный сервер 1 | https://wargm.ru/server/10001\nДемонстрационный сервер 2 | https://wargm.ru/server/10002\nДемонстрационный сервер 3 | https://wargm.ru/server/10003");
  await page.locator("#addForm button").click();
  await page.waitForFunction(() => document.querySelectorAll(".server").length === 3);
  assert.equal(await page.locator(".server").first().getByRole("button", { name: "Я проголосовал", exact: true }).isDisabled(), true);
  await page.locator("#toggle").click();
  await page.waitForFunction(() => document.getElementById("mode").textContent === "Напоминания включены");
  reports.push("Bulk add and reminder mode work; a mark is disabled before a page is opened.");

  await page.locator("#openNext").click();
  await page.waitForFunction(() => document.querySelector(".server-state").textContent.startsWith("Страница открыта"));
  const openedTabs = await worker.evaluate(() => self.testOpenedTabs);
  assert.equal(openedTabs.length, 1);
  assert.equal(openedTabs[0].requested.url, "https://wargm.ru/server/10001");
  assert.equal(openedTabs[0].requested.active, true);
  await page.bringToFront();
  await page.waitForFunction(() => !document.body.hasAttribute("aria-busy"));
  const first = page.locator(".server").first();
  await first.getByRole("button", { name: "Я проголосовал", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".server-state").textContent.includes("Следующее напоминание"));
  assert.equal(await page.locator("#readyCount").textContent(), "2");
  await worker.evaluate(id => chrome.tabs.remove(id), openedTabs[0].id);
  const stored = await page.evaluate(async () => (await chrome.storage.local.get("twinkleState")).twinkleState);
  assert.equal(stored.servers[0].dueAt - stored.servers[0].lastVoteAt, 57600000);
  reports.push("An explicit click requests one WARGM tab, substituted with about:blank in the test; user mark starts exactly 16 hours.");

  await first.getByRole("button", { name: "Отменить отметку", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("readyCount").textContent === "3");
  await first.getByRole("button", { name: "Через час", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("readyCount").textContent === "2");
  reports.push("Undo and one-hour postpone work without fabricating successful votes.");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  const downloaded = path.join(results, "export.json");
  await download.saveAs(downloaded);
  const backup = JSON.parse(await readFile(downloaded, "utf8"));
  assert.equal(backup.servers.length, 3);
  assert.deepEqual(Object.keys(backup.servers[0]).sort(), ["name", "url"]);
  await page.locator("#importFile").setInputFiles(downloaded);
  await page.waitForFunction(() => document.getElementById("feedback").textContent.startsWith("Добавлено серверов: 0"));
  assert.equal(await page.locator(".server").count(), 3);
  reports.push("Export/import round trip preserves names and URLs and skips duplicates.");

  await page.locator("#links").fill("https://wargm.ru.evil.test/server/1");
  await page.locator("#addForm button").click();
  await page.waitForFunction(() => document.getElementById("feedback").classList.contains("error"));
  assert.equal(await page.locator(".server").count(), 3);
  await page.locator("#links").fill("");
  reports.push("Untrusted domains are rejected with a Russian error.");

  await first.getByRole("button", { name: "Название", exact: true }).click();
  await page.locator("#editName").fill("<img src=x onerror=alert(1)>");
  await page.locator("#editForm button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector(".server-name").textContent.startsWith("<img"));
  assert.equal(await page.locator("#servers img").count(), 0);
  await first.getByRole("button", { name: "Название", exact: true }).click();
  await page.locator("#editName").fill("Демонстрационный сервер 1");
  await page.locator("#editForm button[type=submit]").click();
  await page.waitForFunction(() => !document.getElementById("editDialog").open);
  reports.push("Server names remain text; HTML is not executed.");

  await page.evaluate(() => { document.getElementById("feedback").hidden = true; });
  await page.screenshot({ path: path.join(results, "02-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(results, "store-1280x800.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(results, "03-mobile.png"), fullPage: true });
  reports.push("Desktop and narrow layout have screenshots; narrow layout has no horizontal overflow.");

  await page.setViewportSize({ width: 1280, height: 1000 });
  await first.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.locator("#cancelDelete").click();
  assert.equal(await page.locator(".server").count(), 3);
  await first.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.locator("#confirmDelete").click();
  await page.waitForFunction(() => document.querySelectorAll(".server").length === 2);
  await page.locator("#toggle").click();
  await page.waitForFunction(() => document.getElementById("mode").textContent === "На паузе");
  const alarms = await page.evaluate(() => chrome.alarms.getAll());
  assert.equal(alarms.length, 0);
  reports.push("Deletion requires confirmation; pause removes scheduled alarms.");

  await context.close();
  context = await launch();
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".server").length === 2);
  assert.equal(await page.locator("#mode").textContent(), "На паузе");
  reports.push("Server list and pause survive a real browser restart.");
  assert.deepEqual(errors, []);
  reports.push("No page JavaScript errors.");
  const report = { browser: context.browser()?.version() || "Chromium", passed: reports,
    notRun: ["Live WARGM authorization and voting", "Windows notification delivery", "Chrome Web Store review"] };
  await writeFile(path.join(results, "browser-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(results, "failure.png"), fullPage: true }).catch(() => {});
    console.error((await page.locator("body").innerText()).slice(0, 3500));
  }
  throw error;
} finally {
  await context.close();
}
