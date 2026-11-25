import { z } from "zod";

export const displayNameLimit = 32;
export const blockCharLimit = 4;
export const combiningMarkRunLimit = 3;

// Letters and digits in any script (Latin, Cyrillic, CJK, ...), the combining
// marks some scripts need, spaces, hyphens, apostrophes (' and ’), and a few "█".
const allowedName = /^[\p{L}\p{M}\p{N} '’\-█]+$/u;
// Characters that render as nothing, e.g. Hangul fillers (U+3164), which are
// classed as letters and would otherwise make a blank-looking name valid.
const invisible = /\p{Default_Ignorable_Code_Point}/u;
// A name must show at least one real letter or digit, not just "-", "'" or "█".
const visibleLetterOrDigit = /[\p{L}\p{N}]/u;
// Combining marks must follow a base character, and long stacks ("zalgo") are out.
const leadingMark = /^\p{M}/u;
const markRun = new RegExp(`\\p{M}{${combiningMarkRunLimit + 1},}`, "u");

export function normalizeDisplayName(value: string): string {
  return value.normalize("NFC").trim().replace(/ {2,}/g, " ");
}

export function displayNameError(value: string): string | null {
  if (!value) return "empty";
  if ([...value].length > displayNameLimit) return "too_long";
  if (!allowedName.test(value) || invisible.test(value))
    return "invalid_characters";
  if (!visibleLetterOrDigit.test(value)) return "no_letters";
  if (leadingMark.test(value) || markRun.test(value)) return "invalid_marks";
  if ((value.match(/█/g)?.length ?? 0) > blockCharLimit) return "too_many_blocks";
  return null;
}

export const displayNameSchema = z
  .string()
  .max(displayNameLimit * 4)
  .transform(normalizeDisplayName)
  .refine((value) => displayNameError(value) === null);

// For names that come from an identity provider rather than the user: keep
// them when they are valid, otherwise fall back (e.g. to the handle).
export function displayNameOr(raw: string | null | undefined, fallback: string) {
  const name = normalizeDisplayName(raw ?? "");
  const clipped = [...name].slice(0, displayNameLimit).join("").trim();
  return displayNameError(clipped) === null ? clipped : fallback;
}
