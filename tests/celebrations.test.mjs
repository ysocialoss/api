import { test } from "node:test";
import assert from "node:assert/strict";
import { activeCelebrations } from "../src/celebrations.ts";

const utc = (iso) => new Date(`${iso}Z`);

test("the anniversary covers December 17 in Berlin time", () => {
  assert.equal(activeCelebrations(utc("2026-12-16T22:59:59")).anniversary, false);
  assert.equal(activeCelebrations(utc("2026-12-16T23:00:00")).anniversary, true);
  assert.equal(activeCelebrations(utc("2026-12-17T22:59:59")).anniversary, true);
  assert.equal(activeCelebrations(utc("2026-12-17T23:00:00")).anniversary, false);
  assert.equal(activeCelebrations(utc("2027-12-17T12:00:00")).anniversary, false);
});

test("Christmas flags follow the Berlin date", () => {
  assert.equal(activeCelebrations(utc("2026-11-30T22:59:59")).christmasSeason, false);
  assert.equal(activeCelebrations(utc("2026-11-30T23:00:00")).christmasSeason, true);
  assert.equal(activeCelebrations(utc("2026-12-24T12:00:00")).christmasEve, true);
  assert.equal(activeCelebrations(utc("2026-12-24T23:00:00")).christmasSeason, false);
  assert.equal(activeCelebrations(utc("2026-12-26T22:59:59")).giftSeason, true);
  assert.equal(activeCelebrations(utc("2026-12-26T23:00:00")).giftSeason, false);
});

test("the Eve star stays visible until the end of January", () => {
  assert.equal(activeCelebrations(utc("2027-01-31T22:59:59")).eveStarSince, 2026);
  assert.equal(activeCelebrations(utc("2027-01-31T23:00:00")).eveStarSince, 2027);
});

test("the server reports its own time", () => {
  assert.equal(activeCelebrations(utc("2026-12-17T12:00:00")).now, "2026-12-17T12:00:00.000Z");
});

test("awareness days pick the matching logo", () => {
  assert.equal(activeCelebrations(utc("2026-06-10T12:00:00")).branding, "pride-month");
  assert.equal(activeCelebrations(utc("2026-02-04T12:00:00")).branding, "world-cancer-day");
  assert.equal(activeCelebrations(utc("2026-04-22T12:00:00")).branding, "earth-day");
  assert.equal(activeCelebrations(utc("2026-03-10T12:00:00")).branding, null);
});
