import { z } from "zod";

export const displayNameLimit = 32;
export const blockCharLimit = 4;

// Letters and digits in any script (Latin, Cyrillic, CJK, ...), the combining
// marks some scripts need, spaces, hyphens, apostrophes (' and ’), and a few "█".
const allowedName = /^[\p{L}\p{M}\p{N} '’\-█]+$/u;

export function displayNameError(value: string): string | null {
  if (!allowedName.test(value)) return "invalid_characters";
  if ((value.match(/█/g)?.length ?? 0) > blockCharLimit) return "too_many_blocks";
  return null;
}

export const displayNameSchema = z.string().trim().min(1).max(displayNameLimit)
  .refine((value) => displayNameError(value) === null);
