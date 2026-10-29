import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { loadSource } from "../test-source.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-media-"));
process.env.DELIVERY_PROVIDER = "mock";
process.env.DB_PATH = path.join(dir, "crm.db");
process.env.UPLOAD_DIR = path.join(dir, "uploads");
process.env.AUTH_SECRET = "x".repeat(40);
process.env.CRM_PUBLIC_URL = "https://crm.example.test";
process.env.SECURITY_ALLOWED_ORIGINS = "https://crm.example.test";
process.env.EVOLUTION_BASE_URL = "http://evolution.internal";
process.env.EVOLUTION_INSTANCE = "store";
process.env.EVOLUTION_API_KEY = "evolution-key";

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "server-only" ? {} : originalLoad.call(this, name, ...args);
};

const { getDb } = loadSource("@/lib/db");
const media = loadSource("@/lib/whatsapp/media");
const db = getDb();

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Replaces globalThis.fetch with an Evolution-like handler over the parsed JSON body. */
function stubEvolution(handler) {
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : {};
    return handler(String(url), body);
  };
}

function mediaResponse(base64, mimetype = "application/octet-stream") {
  return new Response(JSON.stringify({ base64, mimetype }), { status: 200 });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function waFiles() {
  try {
    return fs.readdirSync(path.join(process.env.UPLOAD_DIR, "wa"), { recursive: true });
  } catch {
    return [];
  }
}

function insertWaMessage(id, fields) {
  db.prepare(
    `INSERT INTO wa_messages
       (id, conversation_id, direction, author, kind, body, transcript,
        media_path, media_mime, media_sha256, media_bytes, created_at)
     VALUES (?, 'conv-media', 'in', 'customer', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.kind ?? "audio",
    fields.body ?? null,
    fields.transcript ?? null,
    fields.mediaPath ?? null,
    fields.mime ?? null,
    fields.sha ?? null,
    fields.bytes ?? null,
    fields.createdAt,
  );
}

const isMediaError = (kind) => (err) => err instanceof media.MediaError && err.kind === kind;

test("sniffMime detects every supported container by magic bytes", () => {
  assert.equal(media.sniffMime(Buffer.from("OggS\0\0more bytes")), "audio/ogg");
  assert.equal(media.sniffMime(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16, 3)])), "audio/mpeg");
  for (const second of [0xfb, 0xf3, 0xf2]) {
    assert.equal(media.sniffMime(Buffer.from([0xff, second, 0x90, 0x44])), "audio/mpeg");
  }
  const ftyp = (brand) => Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(8)]);
  assert.equal(media.sniffMime(ftyp("M4A ")), "audio/mp4");
  assert.equal(media.sniffMime(ftyp("isom")), "audio/mp4");
  assert.equal(media.sniffMime(ftyp("mp42")), "audio/mp4");
  assert.equal(media.sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])), "audio/wav");
  assert.equal(media.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), "image/jpeg");
  assert.equal(media.sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(media.sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
  assert.equal(media.sniffMime(Buffer.from("plain text, not media")), null);
  assert.equal(media.sniffMime(Buffer.from([0x12, 0x34])), null);
  assert.equal(media.sniffMime(Buffer.alloc(0)), null);
});

test("fetchInboundMedia downloads, sniffs, hashes and stores a voice note privately", async () => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(96, 0x1a)]);
  let seen = null;
  stubEvolution((url, body) => {
    seen = { url, body };
    // The declared mimetype is deliberately wrong: sniffing must win.
    return mediaResponse(ogg.toString("base64"), "video/mp4");
  });
  const stored = await media.fetchInboundMedia({ waMessageId: "w-1", remoteJid: "j", expected: "audio" });

  assert.ok(seen);
  assert.ok(seen.url.startsWith("http://evolution.internal/chat/getBase64FromMediaMessage/store"));
  assert.equal(seen.body.message.key.id, "w-1");
  assert.equal(seen.body.message.key.remoteJid, "j");
  assert.equal(seen.body.message.key.fromMe, false);

  assert.equal(stored.kind, "audio");
  assert.equal(stored.mime, "audio/ogg");
  assert.equal(stored.bytes, ogg.length);
  assert.equal(stored.sha256, sha256(ogg));
  assert.match(stored.relPath, /^wa\/\d{4}\/\d{2}\/[a-f0-9]{64}\.ogg$/);

  const abs = path.join(process.env.UPLOAD_DIR, stored.relPath);
  assert.deepEqual(fs.readFileSync(abs), ogg);
  assert.equal(fs.statSync(abs).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.dirname(abs)).mode & 0o777, 0o750);
});

test("content whose sniffed type does not match the expected kind is rejected", async () => {
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#204060" } }).png().toBuffer();
  stubEvolution(() => mediaResponse(png.toString("base64"), "audio/ogg"));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "w-2", remoteJid: "j", expected: "audio" }),
    isMediaError("unsupported"),
  );
  stubEvolution(() => mediaResponse(Buffer.from("definitely not media").toString("base64")));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "w-3", remoteJid: "j", expected: "image" }),
    isMediaError("unsupported"),
  );
});

test("oversized media is rejected before anything is stored", async () => {
  const bigAudio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16 * 1024 * 1024, 7)]);
  stubEvolution(() => mediaResponse(bigAudio.toString("base64")));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "big-audio", remoteJid: "j", expected: "audio" }),
    isMediaError("too_large"),
  );
  const bigImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(10 * 1024 * 1024, 7)]);
  stubEvolution(() => mediaResponse(bigImage.toString("base64")));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "big-image", remoteJid: "j", expected: "image" }),
    isMediaError("too_large"),
  );
  assert.ok(!waFiles().some((f) => f.includes(sha256(bigAudio))));
  assert.ok(!waFiles().some((f) => f.includes(sha256(bigImage))));
});

test("identical content is stored once under the same hash", async () => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32, 0x5f)]);
  stubEvolution(() => mediaResponse(ogg.toString("base64")));
  const first = await media.fetchInboundMedia({ waMessageId: "dup-1", remoteJid: "j", expected: "audio" });
  const second = await media.fetchInboundMedia({ waMessageId: "dup-2", remoteJid: "j", expected: "audio" });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.relPath, second.relPath);
  assert.equal(waFiles().filter((f) => f.includes(first.sha256)).length, 1);
});

test("path traversal is refused and legit paths still read back", async () => {
  assert.throws(() => media.absoluteMediaPath("../x"), isMediaError("permanent"));
  assert.throws(() => media.absoluteMediaPath("wa/../../outside.txt"), isMediaError("permanent"));
  assert.throws(() => media.absoluteMediaPath("/etc/passwd"), isMediaError("permanent"));
  await assert.rejects(media.readMedia("../x"), media.MediaError);
  await assert.rejects(media.readMedia("wa/../../outside.txt"), media.MediaError);
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(8, 0x2c)]);
  stubEvolution(() => mediaResponse(ogg.toString("base64")));
  const stored = await media.fetchInboundMedia({ waMessageId: "readback", remoteJid: "j", expected: "audio" });
  assert.deepEqual(await media.readMedia(stored.relPath), ogg);
});

test("imageForVision downscales to a <=1024px JPEG and never upscales", async () => {
  const big = await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#336699" } }).png().toBuffer();
  stubEvolution(() => mediaResponse(big.toString("base64"), "image/png"));
  const stored = await media.fetchInboundMedia({ waMessageId: "img-big", remoteJid: "j", expected: "image" });
  assert.equal(stored.kind, "image");
  assert.equal(stored.mime, "image/png");
  assert.match(stored.relPath, /\.png$/);
  const vision = await media.imageForVision(stored.relPath);
  assert.equal(vision.mime, "image/jpeg");
  const meta = await sharp(Buffer.from(vision.base64, "base64")).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(meta.width <= 1024 && meta.height <= 1024);
  assert.equal(meta.width, 1024);

  const small = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#101010" } }).png().toBuffer();
  stubEvolution(() => mediaResponse(small.toString("base64")));
  const storedSmall = await media.fetchInboundMedia({ waMessageId: "img-small", remoteJid: "j", expected: "image" });
  const smallOut = await media.imageForVision(storedSmall.relPath);
  const smallMeta = await sharp(Buffer.from(smallOut.base64, "base64")).metadata();
  assert.equal(smallMeta.width, 80);
  assert.equal(smallMeta.height, 60);
});

test("purge deletes expired files, keeps transcripts and shared files", async () => {
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const old = iso(nowMs - 91 * 86_400_000);
  const recent = iso(nowMs - 1 * 86_400_000);
  const fixedNow = new Date(nowMs);
  db.prepare(
    "INSERT INTO wa_conversations (id, phone, created_at, updated_at) VALUES ('conv-media', '+212600000009', ?, ?)",
  ).run(iso(nowMs - 92 * 86_400_000), iso(nowMs - 92 * 86_400_000));

  const store = async (waMessageId, buf) => {
    stubEvolution(() => mediaResponse(buf.toString("base64")));
    return media.fetchInboundMedia({ waMessageId, remoteJid: "j", expected: "audio" });
  };
  const lonely = await store("purge-lonely", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20, 0x11)]));
  const shared = await store("purge-shared", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20, 0x22)]));
  const lonelyAbs = path.join(process.env.UPLOAD_DIR, lonely.relPath);
  const sharedAbs = path.join(process.env.UPLOAD_DIR, shared.relPath);
  assert.ok(fs.existsSync(lonelyAbs) && fs.existsSync(sharedAbs));

  insertWaMessage("m-lonely", {
    createdAt: old,
    mediaPath: lonely.relPath,
    mime: lonely.mime,
    sha: lonely.sha256,
    bytes: lonely.bytes,
    transcript: "صوت قديم من الزبون",
    body: null,
  });
  insertWaMessage("m-old-shared", { createdAt: old, mediaPath: shared.relPath, mime: shared.mime, sha: shared.sha256 });
  insertWaMessage("m-new-shared", { createdAt: recent, mediaPath: shared.relPath, mime: shared.mime, sha: shared.sha256 });
  insertWaMessage("m-gone", {
    createdAt: old,
    mediaPath: "wa/1999/01/missing.mp3",
    mime: "audio/mpeg",
    sha: sha256(Buffer.from("missing")),
  });

  const purged = await media.purgeExpiredMedia(90, fixedNow);
  assert.equal(purged, 3);

  assert.ok(!fs.existsSync(lonelyAbs), "expired unshared file must be deleted");
  await assert.rejects(media.readMedia(lonely.relPath));
  assert.ok(fs.existsSync(sharedAbs), "file still referenced by a newer message must stay");
  assert.deepEqual(await media.readMedia(shared.relPath), Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20, 0x22)]));

  const rows = db
    .prepare("SELECT id, media_deleted_at, transcript, body FROM wa_messages WHERE id IN ('m-lonely','m-new-shared','m-gone')")
    .all();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId["m-lonely"].media_deleted_at);
  assert.equal(byId["m-lonely"].transcript, "صوت قديم من الزبون");
  assert.ok(byId["m-gone"].media_deleted_at, "missing file is tolerated and still marked");
  assert.equal(byId["m-new-shared"].media_deleted_at, null);

  // Nothing left to do on a second run.
  assert.equal(await media.purgeExpiredMedia(90, fixedNow), 0);
  assert.ok(fs.existsSync(sharedAbs));
});

test("Evolution failures map to MediaError kinds", async () => {
  stubEvolution(() => new Response(JSON.stringify({ message: "boom" }), { status: 502 }));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "err-1", remoteJid: "j", expected: "audio" }),
    isMediaError("download"),
  );
  stubEvolution(() => new Response(JSON.stringify({ message: "gone" }), { status: 404 }));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "err-2", remoteJid: "j", expected: "audio" }),
    isMediaError("permanent"),
  );
  stubEvolution(() => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
  });
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "err-3", remoteJid: "j", expected: "audio" }),
    isMediaError("download"),
  );
  stubEvolution(() => mediaResponse(""));
  await assert.rejects(
    media.fetchInboundMedia({ waMessageId: "err-4", remoteJid: "j", expected: "audio" }),
    isMediaError("permanent"),
  );
});

test("without Evolution configuration the fetch fails permanently", async () => {
  const saved = { base: process.env.EVOLUTION_BASE_URL, instance: process.env.EVOLUTION_INSTANCE, key: process.env.EVOLUTION_API_KEY };
  delete process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_INSTANCE;
  delete process.env.EVOLUTION_API_KEY;
  try {
    await assert.rejects(
      media.fetchInboundMedia({ waMessageId: "noconf", remoteJid: "j", expected: "audio" }),
      isMediaError("permanent"),
    );
  } finally {
    process.env.EVOLUTION_BASE_URL = saved.base;
    process.env.EVOLUTION_INSTANCE = saved.instance;
    process.env.EVOLUTION_API_KEY = saved.key;
  }
});
