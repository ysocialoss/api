import { test } from "node:test";
import assert from "node:assert/strict";
import { doorIsOpenable } from "../src/advent.ts";

const utc = (iso) => new Date(`${iso}Z`);

test("a door opens on its day in every time zone", () => {
  assert.equal(doorIsOpenable(2026, 5, utc("2026-12-04T10:00:00")), true);
  assert.equal(doorIsOpenable(2026, 5, utc("2026-12-05T12:00:00")), true);
  assert.equal(doorIsOpenable(2026, 5, utc("2026-12-06T11:59:59")), true);
});

test("a door stays locked before its day and closes after it", () => {
  assert.equal(doorIsOpenable(2026, 5, utc("2026-12-04T09:59:59")), false);
  assert.equal(doorIsOpenable(2026, 5, utc("2026-12-06T12:00:00")), false);
  assert.equal(doorIsOpenable(2026, 1, utc("2026-11-25T12:00:00")), false);
  assert.equal(doorIsOpenable(2025, 24, utc("2026-12-24T12:00:00")), false);
});
