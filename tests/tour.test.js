import test from "node:test";
import assert from "node:assert/strict";
import { parseCooldown, groupOf } from "../extension/tour.js";
test("WARGM cooldown accepts screenshot formats including 60 minutes", () => {
  assert.equal(parseCooldown("15ч. 60м."), 57600000);
  assert.equal(parseCooldown("2ч. 10м."), 7800000);
  assert.equal(parseCooldown("9м."), 540000);
  assert.equal(parseCooldown("15ч.\u00a059м."), 57540000);
});
test("Error text and out-of-range times never count as cooldown", () => {
  for (const text of ["АКТИВАЦИЯ", "ГОЛОСОВАТЬ", "Можно голосовать каждые 16 часов", "0ч. 0м.", "15ч. 61м.", "17ч. 00м.", "Ошибка 15ч. 60м.", null]) assert.equal(parseCooldown(text), null);
});
test("Renaming a Stalker server does not change its group", () => {
  assert.equal(groupOf({ id:"80996", name:"Новое имя" }), "stalker");
  assert.equal(groupOf({ id:"71046", name:"STALKER" }), "main");
});
