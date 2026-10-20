import test from "node:test";
import assert from "node:assert/strict";
import { freshState, canonicalUrl, parseLines, parseBackup, reduceState,
  dueServers, exportList, reminderKey, INTERVAL, SNOOZE } from "../extension/model.js";

const now = 1800000000000;
const add = (state = freshState(), text = "Первый | https://wargm.ru/server/123") =>
  reduceState(state, { type: "add", text }, now);
const open = state => reduceState(state, { type: "opened", id: "123" }, now);
const mark = state => reduceState(state, { type: "mark", id: "123" }, now);

test("Canonical URLs remove tracking and equivalent routes", () => {
  assert.equal(canonicalUrl(" https://www.wargm.ru/server/123/votes?utm_source=x#vote "), "https://wargm.ru/server/123");
});
test("Only HTTPS WARGM server links are accepted", () => {
  for (const url of ["http://wargm.ru/server/1", "https://wargm.ru.evil.test/server/1",
    "https://evil.test/server/1", "https://wargm.ru@evil.test/server/1",
    "https://user:pass@wargm.ru/server/1", "javascript:alert(1)",
    "https://wargm.ru:444/server/1", "https://wargm.ru/faq", "https://wargm.ru/server/0"]) {
    assert.throws(() => canonicalUrl(url), undefined, url);
  }
});
test("Bulk import is atomic when a line is invalid", () => {
  const state = add();
  assert.throws(() => reduceState(state, { type: "add", text: "https://wargm.ru/server/2\nbad" }, now));
  assert.equal(state.servers.length, 1);
  assert.throws(() => parseLines(" \n "));
});
test("Duplicate links do not reset existing schedules or names", () => {
  const state = mark(open(add()));
  const result = add(state, "Другое имя | https://www.wargm.ru/server/123/vote");
  assert.deepEqual(result, state);
});
test("Nineteen servers are accepted and twentieth rejected", () => {
  const state = add(freshState(), Array.from({ length: 19 }, (_, i) => `https://wargm.ru/server/${i + 1}`).join("\n"));
  assert.equal(state.servers.length, 19);
  assert.throws(() => add(state, "https://wargm.ru/server/20"), /19/);
  assert.equal(state.servers.length, 19);
});
test("Notification mode requires servers and a boolean", () => {
  assert.throws(() => reduceState(freshState(), { type: "enable", value: true }, now));
  assert.throws(() => reduceState(add(), { type: "enable", value: "true" }, now));
});
test("An unopened page cannot be marked as voted", () => {
  assert.throws(() => mark(add()), /Сначала/);
});
test("Opening alone neither confirms a vote nor starts the countdown", () => {
  const result = open(add());
  assert.equal(result.servers[0].lastVoteAt, null);
  assert.equal(result.servers[0].dueAt, 0);
  assert.equal(dueServers(result, now).length, 1);
});
test("A manual mark starts exactly sixteen hours and rejects a double mark", () => {
  const state = mark(open(add()));
  assert.equal(state.servers[0].dueAt, now + INTERVAL);
  assert.equal(dueServers(state, now + INTERVAL - 1).length, 0);
  assert.equal(dueServers(state, now + INTERVAL).length, 1);
  assert.throws(() => mark(state));
});
test("Undo restores the previous schedule and does not invent a vote", () => {
  const state = mark(open(add()));
  const result = reduceState(state, { type: "undo", id: "123" }, now + 5000);
  assert.equal(result.servers[0].dueAt, 0);
  assert.equal(result.servers[0].lastVoteAt, null);
  assert.throws(() => reduceState(result, { type: "undo", id: "123" }, now));
});
test("Postpone preserves absence of a vote", () => {
  const result = reduceState(open(add()), { type: "later", id: "123" }, now);
  assert.equal(result.servers[0].dueAt, now + SNOOZE);
  assert.equal(result.servers[0].lastVoteAt, null);
  assert.equal(result.servers[0].openedAt, null);
});
test("Pause preserves schedule", () => {
  const state = mark(open(add()));
  const result = reduceState(state, { type: "enable", value: false }, now);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.servers, state.servers);
});
test("Backup contains only names and URLs and cannot import timestamps", () => {
  const state = mark(open(add()));
  const backup = exportList(state);
  assert.deepEqual(Object.keys(backup.servers[0]).sort(), ["name", "url"]);
  backup.servers[0].dueAt = 999999;
  const result = reduceState(freshState(), { type: "add", backup: JSON.stringify(backup) }, now);
  assert.equal(result.servers[0].dueAt, 0);
  assert.equal(result.servers[0].lastVoteAt, null);
});
test("Malformed and foreign backups are rejected", () => {
  for (const text of ["bad", "{}", "null", JSON.stringify({format:"twinkle-vote-servers",version:1,servers:[{name:"X",url:"https://evil.test"}]})]) {
    assert.throws(() => parseBackup(text));
  }
});
test("Names are bounded and stored as plain text", () => {
  assert.equal(parseLines("<img src=x onerror=alert(1)> | https://wargm.ru/server/123")[0].name, "<img src=x onerror=alert(1)>");
  assert.throws(() => parseLines(`${"X".repeat(71)} | https://wargm.ru/server/123`));
});
test("Removing last server pauses reminders", () => {
  const state = reduceState(add(), { type: "enable", value: true }, now);
  const result = reduceState(state, { type: "remove", id: "123" }, now);
  assert.equal(result.enabled, false);
  assert.equal(result.servers.length, 0);
});
test("Reminder key changes only with due membership or scheduling", () => {
  const state = add();
  const key = reminderKey(state, now);
  assert.equal(reminderKey(open(state), now + 100), key);
  assert.notEqual(reminderKey(mark(open(state)), now), key);
});
test("Local history is bounded", () => {
  let state = add();
  for (let i = 0; i < 100; i++) state = reduceState(state, { type: "enable", value: !!(i % 2) }, now + i);
  assert.equal(state.history.length, 80);
  assert.equal(state.history[0].at, now + 99);
});
