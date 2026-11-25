// Posts and bios allow at most two blank lines in a row.
export function hasTooManyBlankLines(value: string) {
  return /(?:^|\n)(?:[^\S\n]*\n){3}/.test(value.trim().replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, "\n"));
}
