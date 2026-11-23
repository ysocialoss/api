export function isAnimatedPng(data: Buffer) {
  // libvips may expose only the default frame. APNG declares animation before IDAT.
  for (let offset = 8; offset + 12 <= data.length;) {
    const chunk = data.toString("ascii", offset + 4, offset + 8);
    if (chunk === "acTL") return true;
    if (chunk === "IDAT") return false;
    offset += 12 + data.readUInt32BE(offset);
  }
  return false;
}
