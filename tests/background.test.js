import test from "node:test";
import assert from "node:assert/strict";
import { freshState, reduceState, INTERVAL } from "../extension/model.js";

function event() {
  const handlers = [];
  return { addListener: fn => handlers.push(fn), fire: (...args) => handlers.forEach(fn => fn(...args)), handlers };
}

async function fixture(initial = freshState()) {
  const data = initial ? { twinkleState: { defaultServersVersion: 1, ...structuredClone(initial) } } : {};
  const calls = { tabs: [], notices: [], alarms: new Map(), badge: "" };
  const events = { message: event(), startup: event(), installed: event(), alarm: event(),
    clicked: event(), notice: event(), noticeButton: event(), removed: event() };
  let granted = true;
  const chrome = {
    runtime: { id: "test", getURL: path => `chrome-extension://test/${path}`, onMessage: events.message,
      onStartup: events.startup, onInstalled: events.installed, openOptionsPage: async () => {} },
    action: { onClicked: events.clicked, setBadgeBackgroundColor: async () => {},
      setBadgeText: async ({ text }) => { calls.badge = text; }, setTitle: async () => {} },
    storage: { local: { get: async () => structuredClone(data),
      set: async value => Object.assign(data, structuredClone(value)), setAccessLevel: async () => {} } },
    alarms: { create: async (name, value) => { calls.alarms.set(name, value); },
      clear: async name => calls.alarms.delete(name), onAlarm: events.alarm },
    tabs: { create: async value => { calls.tabs.push(value); return { id: calls.tabs.length }; } },
    permissions: { contains: async () => granted, onRemoved: events.removed },
    notifications: { create: async (id, value) => { calls.notices.push({ id, ...value }); },
      clear: async () => true, onClicked: events.notice, onButtonClicked: events.noticeButton }
  };
  globalThis.chrome = chrome;
  await import(`../extension/background.js?test=${Math.random()}`);
  const send = message => new Promise(resolve => {
    events.message.handlers[0](message, { id: "test", url: chrome.runtime.getURL("index.html") }, resolve);
  });
  await send({ type: "get" });
  return { data, calls, chrome, events, send, setGranted: value => { granted = value; } };
}

test("Background serializes concurrent additions without loss", async () => {
  const f = await fixture();
  const replies = await Promise.all([1, 2, 3].map(id => f.send({ type: "add", text: `https://wargm.ru/server/${id}` })));
  assert.ok(replies.every(reply => reply.ok));
  assert.equal(f.data.twinkleState.servers.length, 3);
});
test("Alarms notify once and never open a tab; startup preserves suppression", async () => {
  let state = reduceState(freshState(), { type: "add", text: "https://wargm.ru/server/1" });
  state = { ...state, enabled: true, notifications: true };
  const f = await fixture(state);
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  f.events.startup.fire();
  await f.send({ type: "get" });
  assert.equal(f.calls.notices.length, 1);
  assert.equal(f.calls.tabs.length, 0);
  assert.equal(f.calls.badge, "1");
});
test("User action opens exactly one page; recording alone is separate", async () => {
  const f = await fixture();
  await f.send({ type: "add", text: "https://wargm.ru/server/1" });
  const result = await f.send({ type: "open", id: "1" });
  assert.equal(f.calls.tabs.length, 1);
  assert.equal(result.state.servers[0].lastVoteAt, null);
  const marked = await f.send({ type: "mark", id: "1" });
  assert.equal(marked.state.servers[0].dueAt - marked.state.servers[0].lastVoteAt, INTERVAL);
  assert.equal(f.calls.tabs.length, 1);
});
test("A failed tab creation cannot enable manual confirmation", async () => {
  const f = await fixture();
  await f.send({ type: "add", text: "https://wargm.ru/server/1" });
  f.chrome.tabs.create = async () => { throw new Error("tab unavailable"); };
  assert.equal((await f.send({ type: "open", id: "1" })).ok, false);
  assert.equal((await f.send({ type: "mark", id: "1" })).ok, false);
});
test("Pause clears the schedule and prevents notices", async () => {
  const f = await fixture();
  await f.send({ type: "add", text: "https://wargm.ru/server/1" });
  await f.send({ type: "notifications", value: true });
  await f.send({ type: "enable", value: true });
  assert.ok(f.calls.alarms.size > 0);
  await f.send({ type: "enable", value: false });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  assert.equal(f.calls.alarms.size, 0);
  assert.equal(f.calls.notices.length, 0);
});
test("External pages cannot send extension commands", async () => {
  const f = await fixture();
  const result = f.events.message.handlers[0]({ type: "add", text: "https://wargm.ru/server/1" },
    { id: "test", url: "https://wargm.ru/server/1" }, () => assert.fail("must not respond"));
  assert.equal(result, false);
});
test("Permission denial and revocation leave timers usable", async () => {
  const f = await fixture();
  f.setGranted(false);
  assert.equal((await f.send({ type: "notifications", value: true })).ok, false);
  await f.send({ type: "add", text: "https://wargm.ru/server/1" });
  assert.equal((await f.send({ type: "enable", value: true })).ok, true);
  f.events.removed.fire();
  await f.send({ type: "get" });
  assert.equal(f.data.twinkleState.notifications, false);
  assert.equal(f.calls.badge, "1");
});
test("Snooze suppresses notices without marking any vote", async () => {
  const f = await fixture();
  await f.send({ type: "add", text: "https://wargm.ru/server/1" });
  await f.send({ type: "enable", value: true });
  await f.send({ type: "notifications", value: true });
  await f.send({ type: "snooze" });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  assert.equal(f.calls.notices.length, 0);
  assert.equal(f.data.twinkleState.servers[0].lastVoteAt, null);
});
test("Existing countdown survives a worker restart", async () => {
  let state = reduceState(freshState(), { type: "add", text: "https://wargm.ru/server/1" });
  state = reduceState(state, { type: "opened", id: "1" });
  state = reduceState(state, { type: "mark", id: "1" });
  state.enabled = true;
  const f = await fixture(state);
  const reply = await f.send({ type: "get" });
  assert.equal(reply.state.servers[0].dueAt, state.servers[0].dueAt);
  assert.ok(f.calls.alarms.size > 0);
});
test("Marking one of several due servers does not repeat the same reminder", async () => {
  const f = await fixture();
  await f.send({ type: "add", text: "https://wargm.ru/server/1\nhttps://wargm.ru/server/2" });
  await f.send({ type: "enable", value: true });
  await f.send({ type: "notifications", value: true });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  assert.equal(f.calls.notices.length, 1);
  await f.send({ type: "open", id: "1" });
  await f.send({ type: "mark", id: "1" });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  assert.equal(f.calls.notices.length, 1);
  await f.send({ type: "add", text: "https://wargm.ru/server/3" });
  f.events.alarm.fire({ name: "twinkle-reminder" });
  await f.send({ type: "get" });
  assert.equal(f.calls.notices.length, 2);
});

test("New installation saves bundled servers once and never opens pages", async () => {
  const f = await fixture(null);
  assert.equal(f.data.twinkleState.servers.length, 19);
  assert.equal(f.data.twinkleState.defaultServersVersion, 1);
  const id = f.data.twinkleState.servers[0].id;
  await f.send({ type: "remove", id });
  f.events.installed.fire();
  f.events.startup.fire();
  const reply = await f.send({ type: "get" });
  assert.equal(reply.state.servers.length, 18);
  assert.equal(reply.state.servers.some(s => s.id === id), false);
  assert.equal(f.calls.tabs.length, 0);
});
