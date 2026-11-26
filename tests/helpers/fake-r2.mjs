import assert from "node:assert/strict";
import { Readable } from "node:stream";

const types = { avif: "image/avif", png: "image/png", gif: "image/gif", webp: "image/webp", m4a: "audio/mp4" };
const listing = (keys) => `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${keys
  .map((key) => `<Contents><Key>${key}</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>`)
  .join("")}</ListBucketResult>`;
const reply = (statusCode, body, headers = {}) => ({ response: { statusCode, headers, body: Readable.from([body]) } });

/**
 * Replaces only R2's HTTP transport with an in-memory bucket; AWS request serialization and
 * everything above it stay real. Returns the bucket (key → Buffer) for assertions.
 *
 * - `keys`: every object key the code under test touches must match it.
 * - `onPut(request, key)` / `onDelete(key)`: extra checks or simulated failures (throw).
 * - `allowMissing`: GET of an unknown key returns an empty body instead of failing the test.
 */
export function fakeR2(t, storage, { keys, onPut, onDelete, allowMissing = false } = {}) {
  const objects = new Map();
  t.mock.method(storage.client.config.requestHandler, "handle", async (request) => {
    assert.match(request.hostname, /\.eu\.r2\.cloudflarestorage\.com$/);
    if (request.query?.["list-type"] === "2") {
      const matching = [...objects.keys()].filter((key) => key.startsWith(request.query.prefix));
      return reply(200, Buffer.from(listing(matching)), { "content-type": "application/xml" });
    }
    const key = decodeURIComponent(request.path.split("/").slice(-2).join("/"));
    if (keys) assert.match(key, keys);
    if (request.method === "PUT") {
      await onPut?.(request, key);
      objects.set(key, Buffer.from(request.body));
      return reply(200, Buffer.alloc(0));
    }
    if (request.method === "DELETE") {
      await onDelete?.(key);
      objects.delete(key);
      return reply(204, Buffer.alloc(0));
    }
    assert.equal(request.method, "GET");
    if (!allowMissing) assert.ok(objects.has(key), "missing object " + key);
    const type = types[key.split(".").pop()] ?? "application/octet-stream";
    return reply(200, objects.get(key) ?? Buffer.alloc(0), { "content-type": type });
  });
  return objects;
}
