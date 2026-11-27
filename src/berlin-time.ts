const format = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

export function berlinDate(at: Date) {
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month - 1, day: parts.day };
}
