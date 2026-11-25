import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNameSchema, displayNameOr } from "../src/display-name.ts";

const ok = (value) => displayNameSchema.safeParse(value);

test("accepts ordinary names in any script", () => {
  for (const name of ["Ada", "José Ñúñez", "O’Brien", "Jean-Luc", "李小龙", "Тоня", "R2D2", "Ana █"])
    assert.equal(ok(name).success, true, name);
});

test("normalizes whitespace", () => {
  assert.equal(ok("  Ada   Lovelace ").data, "Ada Lovelace");
});

test("rejects names that look empty", () => {
  for (const name of ["", "   ", "ㅤ", "ㅤㅤ", "ᅟᅠ", "ﾠ", "Adaㅤ", "-", "' -", "██", "́́", "a​b"])
    assert.equal(ok(name).success, false, JSON.stringify(name));
});

test("rejects stacked combining marks", () => {
  assert.equal(ok("x̂̃̄̅").success, false);
  assert.equal(ok("é").success, true);
});

test("onboarding falls back to the handle for unusable provider names", () => {
  assert.equal(displayNameOr("", "ada"), "ada");
  assert.equal(displayNameOr(null, "ada"), "ada");
  assert.equal(displayNameOr("ㅤ", "ada"), "ada");
  assert.equal(displayNameOr(" Ada ", "ada"), "Ada");
  assert.equal(displayNameOr("x".repeat(40), "ada"), "x".repeat(32));
});
