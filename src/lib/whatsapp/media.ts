import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "@/lib/db";
import { getUploadDir } from "@/lib/uploads";
import { getWhatsAppSender, WhatsAppError } from "@/lib/whatsapp/evolution";

/** Inbound media families the pipeline accepts. */
export type MediaKind = "audio" | "image";

export type MediaErrorKind = "unsupported" | "too_large" | "download" | "permanent";

export class MediaError extends Error {
  constructor(
    public kind: MediaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
    Object.setPrototypeOf(this, MediaError.prototype);
  }
}

export interface StoredMedia {
  /** Path under the uploads root, always starting with `wa/` (no phone data in it). */
  relPath: string;
  /** Magic-byte sniffed type; the declared mimetype is never trusted. */
  mime: string;
  bytes: number;
  sha256: string;
  kind: MediaKind;
}

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const AUDIO_MIMES = new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function kindOf(mime: string): MediaKind | null {
  if (AUDIO_MIMES.has(mime)) return "audio";
  if (IMAGE_MIMES.has(mime)) return "image";
  return null;
}

const ascii = (buf: Buffer, start: number, end: number): string => buf.subarray(start, end).toString("latin1");

/**
 * Magic-byte sniffing of the audio and image containers WhatsApp sends.
 * Returns null for anything else (never trust the declared mimetype).
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 4 && ascii(buf, 0, 4) === "OggS") return "audio/ogg";
  if (buf.length >= 3 && ascii(buf, 0, 3) === "ID3") return "audio/mpeg";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) {
    return "audio/mpeg";
  }
  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (brand === "M4A " || brand.startsWith("mp4") || brand === "isom" || brand === "iso2") {
      return "audio/mp4";
    }
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF") {
    const sub = ascii(buf, 8, 12);
    if (sub === "WAVE") return "audio/wav";
    if (sub === "WEBP") return "image/webp";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  return null;
}

/** Year/month folder for storage, in Africa/Casablanca time (`YYYY/MM`). */
function waMonthDir(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${value("year")}/${value("month")}`;
}

/**
 * Resolves a stored media path under the uploads root. Only `wa/...` paths that
 * stay inside the root are accepted; anything else (traversal, absolute paths,
 * other upload families) is rejected.
 */
export function absoluteMediaPath(relPath: string): string {
  const root = path.resolve(getUploadDir());
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (!rel || path.isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith(`wa${path.sep}`)) {
    throw new MediaError("permanent", "Chemin de média invalide.");
  }
  return resolved;
}

/** Creates the `wa/YYYY/MM` folders with private modes and returns the leaf dir. */
async function ensureWaDir(now: Date): Promise<string> {
  let dir = path.resolve(getUploadDir());
  for (const part of `wa/${waMonthDir(now)}`.split("/")) {
    dir = path.join(dir, part);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await chmod(dir, 0o750).catch(() => {});
  }
  return dir;
}

/** Content-addressed atomic write: temp file first, then rename; reuses existing files. */
async function storeBuffer(relPath: string, buf: Buffer, now: Date): Promise<void> {
  const abs = absoluteMediaPath(relPath);
  try {
    await stat(abs);
    return; // Same hash was stored before.
  } catch {
    // Not stored yet.
  }
  const dir = await ensureWaDir(now);
  const tmp = path.join(dir, `${path.basename(abs)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, buf, { mode: 0o640 });
    await chmod(tmp, 0o640);
    await rename(tmp, abs);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Downloads an inbound voice note or image from Evolution, checks its real type
 * by magic bytes, caps its size and stores it privately under `wa/YYYY/MM/`.
 * A retryable Evolution failure becomes `MediaError("download")` (caller may
 * retry); a permanent one becomes `MediaError("permanent")`.
 */
export async function fetchInboundMedia(input: {
  waMessageId: string;
  remoteJid: string;
  expected: MediaKind;
}): Promise<StoredMedia> {
  if (!input.waMessageId || !input.remoteJid) {
    throw new MediaError("permanent", "Message WhatsApp sans identifiant de média.");
  }
  const sender = getWhatsAppSender();
  if (!sender) {
    throw new MediaError("permanent", "WhatsApp non configuré.");
  }
  let base64: string;
  try {
    ({ base64 } = await sender.getMediaBase64(input.waMessageId, input.remoteJid, false));
  } catch (error) {
    if (error instanceof WhatsAppError) {
      // A download is idempotent, so an uncertain result is safe to retry.
      throw new MediaError(
        error.kind === "permanent" ? "permanent" : "download",
        error.kind === "permanent" ? "Téléchargement du média impossible." : "Téléchargement du média indisponible.",
      );
    }
    throw error;
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length > (input.expected === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES)) {
    throw new MediaError("too_large", "Média trop volumineux.");
  }
  const mime = sniffMime(buf);
  if (!mime || kindOf(mime) !== input.expected) {
    throw new MediaError("unsupported", "Type de média non pris en charge.");
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const now = new Date();
  const relPath = `wa/${waMonthDir(now)}/${sha256}.${MIME_EXT[mime]}`;
  await storeBuffer(relPath, buf, now);
  return { relPath, mime, bytes: buf.length, sha256, kind: input.expected };
}

/** Reads stored WhatsApp media by path, refusing anything outside `wa/`. */
export async function readMedia(relPath: string): Promise<Buffer> {
  return readFile(absoluteMediaPath(relPath));
}

/**
 * Downscales a stored image for vision models: EXIF rotation applied, fit
 * inside 1024×1024 without enlargement, JPEG q75. Never serves the original.
 */
export async function imageForVision(relPath: string): Promise<{ base64: string; mime: "image/jpeg" }> {
  const buf = await readMedia(relPath);
  try {
    const output = await sharp(buf, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { base64: output.toString("base64"), mime: "image/jpeg" };
  } catch {
    throw new MediaError("permanent", "Image illisible.");
  }
}

interface PurgeRow {
  id: string;
  media_path: string;
  media_sha256: string | null;
}

/**
 * Marks expired WhatsApp media as deleted: unlinks each file only when no other
 * non-deleted message still references the same content hash, ignores missing
 * files, keeps `transcript` and `body`, and processes at most 200 rows per call.
 */
export async function purgeExpiredMedia(retentionDays: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, media_path, media_sha256 FROM wa_messages
       WHERE media_path IS NOT NULL AND media_deleted_at IS NULL AND created_at < ?
       ORDER BY created_at LIMIT 200`,
    )
    .all(cutoff) as PurgeRow[];
  const countBySha = db.prepare(
    "SELECT COUNT(*) AS n FROM wa_messages WHERE media_sha256 = ? AND media_deleted_at IS NULL",
  );
  const countByPath = db.prepare(
    "SELECT COUNT(*) AS n FROM wa_messages WHERE media_path = ? AND media_deleted_at IS NULL",
  );
  const mark = db.prepare(
    "UPDATE wa_messages SET media_deleted_at = ? WHERE id = ? AND media_deleted_at IS NULL",
  );
  const nowIso = now.toISOString();
  let purged = 0;
  for (const row of rows) {
    let refs: { n: number } | undefined;
    if (row.media_sha256) {
      refs = countBySha.get(row.media_sha256) as { n: number } | undefined;
    } else {
      refs = countByPath.get(row.media_path) as { n: number } | undefined;
    }
    if (!refs || refs.n <= 1) {
      try {
        await unlink(absoluteMediaPath(row.media_path));
      } catch {
        // Already gone or invalid stored path: the content is unreachable either way.
      }
    }
    mark.run(nowIso, row.id);
    purged += 1;
  }
  return purged;
}
