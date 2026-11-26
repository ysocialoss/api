import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://banner:banner@localhost/banner";
process.env.KLIPY_API_KEY = "banner-test-key";

const { bannerUploadLimit, normalizeBanner } = await import(
  "../src/storage/banner-image.ts"
);

async function photo(width, height, format) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const noise = (Math.random() * 12) | 0;
      raw[i] = ((x / width) * 220 + noise) & 255;
      raw[i + 1] = ((y / height) * 220 + noise) & 255;
      raw[i + 2] = (((x + y) / (width + height)) * 220 + noise) & 255;
    }
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === "png"
    ? image.png({ compressionLevel: 1 }).toBuffer()
    : image.jpeg({ quality: 95 }).toBuffer();
}

await test("a large still banner is shrunk to a sensible size", async () => {
  for (const format of ["png", "jpeg"]) {
    const input = await photo(2400, 1200, format);
    assert.ok(input.length > 300 * 1024, `${format} input is large`);
    assert.ok(input.length <= bannerUploadLimit, `${format} input is accepted`);
    const banner = await normalizeBanner(input);
    assert.equal(banner.extension, "avif");
    assert.equal(banner.contentType, "image/avif");
    assert.ok(banner.body.length < input.length / 2, `${format} shrank`);
    const metadata = await sharp(banner.body).metadata();
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 800);
  }
});

await test("compression keeps the aspect ratio so saved crops still fit", async () => {
  const banner = await normalizeBanner(await photo(2400, 600, "jpeg"));
  const metadata = await sharp(banner.body).metadata();
  assert.equal(metadata.width / metadata.height, 4);
});

await test("a tiny still banner is re-encoded instead of stored as uploaded", async () => {
  const tiny = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#16dc64" },
  })
    .png()
    .toBuffer();
  const banner = await normalizeBanner(tiny);
  assert.ok(["png", "avif"].includes(banner.extension));
  assert.equal(banner.animated, false);
});

await test("small animations stay gifs but are re-encoded", async () => {
  const gif = await readFile(new URL("./fixtures/banner.gif", import.meta.url));
  const banner = await normalizeBanner(gif);
  assert.equal(banner.extension, "gif");
  assert.equal(banner.animated, true);
  assert.equal((await sharp(banner.body, { animated: true }).metadata()).pages, 24);
});

await test("location and camera metadata never survive any banner path", async () => {
  const exif = { IFD0: { Make: "LeakCam", Model: "GPS-1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "53/1 36/1 0/1" } };
  for (const size of [[2400, 1200], [8, 8]]) {
    const input = await sharp(await photo(size[0], size[1], "jpeg")).withExif(exif).jpeg({ quality: 95 }).toBuffer();
    assert.ok((await sharp(input).metadata()).exif, "fixture carries exif");
    const banner = await normalizeBanner(input);
    const metadata = await sharp(banner.body).metadata();
    assert.equal(metadata.exif, undefined);
    assert.ok(!banner.body.includes(Buffer.from("LeakCam")));
  }
});

await test("wide animations stay animated and get smaller", async () => {
  const fixture = await readFile(new URL("./fixtures/banner.gif", import.meta.url));
  const input = await sharp(fixture, { animated: true })
    .resize({ width: 1800 })
    .gif()
    .toBuffer();
  const before = await sharp(input, { animated: true }).metadata();
  assert.equal(before.width, 1800);
  assert.equal(before.pages, 24);
  const banner = await normalizeBanner(input);
  assert.equal(banner.extension, "webp");
  const after = await sharp(banner.body, { animated: true }).metadata();
  assert.equal(after.pages, 24);
  assert.equal(after.width, 960);
  assert.ok(banner.body.length < input.length);
});

await test("invalid and oversized uploads are still rejected", async () => {
  await assert.rejects(normalizeBanner(Buffer.from("not an image")), {
    message: "invalid_banner",
  });
  await assert.rejects(normalizeBanner(Buffer.alloc(bannerUploadLimit + 1)), {
    message: "invalid_banner",
  });
});
