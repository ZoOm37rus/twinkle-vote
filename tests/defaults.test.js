import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERVERS } from "../extension/default-servers.js";
import { freshState, initializeDefaults, reduceState, canonicalUrl } from "../extension/model.js";

test("Bundled project has exactly nineteen unique valid server links", () => {
  assert.equal(DEFAULT_SERVERS.length, 19);
  assert.equal(new Set(DEFAULT_SERVERS.map(s => canonicalUrl(s.url))).size, 19);
  assert.ok(DEFAULT_SERVERS.every(s => s.name.startsWith("TWINKLE Play") && s.name.length <= 70));
});
test("First initialization persists defaults without enabling reminders or inventing votes", () => {
  const state = initializeDefaults(freshState());
  assert.equal(state.servers.length, 19);
  assert.equal(state.enabled, false);
  assert.ok(state.servers.every(s => s.lastVoteAt === null && s.openedAt === null && s.dueAt === 0));
  assert.equal(initializeDefaults(state), state);
});
test("Upgrade preserves existing names, countdowns and history without duplicates", () => {
  let state = reduceState(freshState(), { type: "add", text: "Мой сервер | https://wargm.ru/server/71046" }, 100);
  state = reduceState(state, { type: "opened", id: "71046" }, 101);
  state = reduceState(state, { type: "mark", id: "71046" }, 102);
  state = reduceState(state, { type: "enable", value: true }, 103);
  const result = initializeDefaults(state, 104);
  assert.equal(result.servers.length, 19);
  assert.deepEqual(result.servers[0], state.servers[0]);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.history.slice(1), state.history);
  assert.equal(state.servers.length, 1);
});
test("Deleted defaults stay deleted across restart including an emptied list", () => {
  let state = initializeDefaults(freshState());
  for (const s of [...state.servers]) state = reduceState(state, { type: "remove", id: s.id });
  assert.equal(initializeDefaults(state).servers.length, 0);
});
test("Upgrade respects a full custom list", () => {
  const state = reduceState(freshState(), { type: "add", text: Array.from({length:19}, (_, i) => `https://wargm.ru/server/${i+1}`).join("\n") });
  const result = initializeDefaults(state);
  assert.deepEqual(result.servers, state.servers);
  assert.equal(result.defaultServersVersion, 1);
});
