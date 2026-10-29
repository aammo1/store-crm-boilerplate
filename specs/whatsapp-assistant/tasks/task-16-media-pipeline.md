# Task 16: Media pipeline

## Status

pending

## Wave

3

## Description

Inbound voice notes and images have to be downloaded from Evolution, checked, stored privately under `data/uploads/wa/`, hashed with SHA-256 (the hash drives the transcript cache), downscaled for vision when they're images, and deleted after the retention period while transcripts are kept. This task builds that pipeline as pure server functions. The inbound processor (task 21) calls `fetchInboundMedia`, and the worker (task 24) calls `purgeExpiredMedia`.

## Dependencies

**Depends on:** task-06-evolution-client.md, task-04-whatsapp-settings.md (task-02 indirectly)
**Blocks:** task-21-inbound-processor, task-24-whatsapp-worker

**Context from dependencies:**
- Task 06 provides `getWhatsAppSender()` in `src/lib/whatsapp/evolution.ts`:
  - `.getMediaBase64(waMessageId, remoteJid, fromMe)` returns `{ base64, mimetype }`
  - throws `WhatsAppError(kind)` with kind `retryable` or `permanent`
  - caps responses at 25 MB of base64
- Task 04 provides `getWhatsAppSettings().mediaRetentionDays` (default 90).
- Task 02 created the media columns on `wa_messages`: `media_path`, `media_mime`, `media_sha256`, `media_bytes`, `media_deleted_at`.
- Existing `src/lib/uploads.ts` defines the uploads root (`data/uploads` locally, `/app/data/uploads` in containers). Reuse its root-path helper; read the file for the exact export. `sharp` is already a dependency. The container runs as UID 1001.

## Files to Create

- `src/lib/whatsapp/media.ts`

## Files to Modify

- None.

## Technical Details

```ts
export type MediaKind = "audio" | "image";
export interface StoredMedia { relPath: string; mime: string; bytes: number; sha256: string; kind: MediaKind }

export async function fetchInboundMedia(input: { waMessageId: string; remoteJid: string; expected: MediaKind }): Promise<StoredMedia>;
export function sniffMime(buf: Buffer): string | null;
export async function readMedia(relPath: string): Promise<Buffer>;           // path-traversal safe
export function absoluteMediaPath(relPath: string): string;                  // resolves under uploads root; throws if escapes
export async function imageForVision(relPath: string): Promise<{ base64: string; mime: "image/jpeg" }>; // sharp: rotate(), resize fit inside 1024x1024, jpeg q75
export async function purgeExpiredMedia(retentionDays: number, now?: Date): Promise<number>;
export class MediaError extends Error { constructor(public kind: "unsupported" | "too_large" | "download" | "permanent", msg: string) }
```

### Rules

**Magic-byte sniffing.** Never trust the declared mimetype.

| Bytes | Type |
|---|---|
| `OggS` at offset 0 | `audio/ogg` |
| `ID3`, or `FF FB` / `FF F3` / `FF F2` | `audio/mpeg` |
| `ftyp` at offset 4, with brand `M4A ` or `mp4`/`isom` | `audio/mp4` |
| `RIFF....WAVE` | `audio/wav` |
| `FF D8 FF` | `image/jpeg` |
| `89 50 4E 47` | `image/png` |
| `RIFF....WEBP` | `image/webp` |

The sniffed type must match `expected`, otherwise throw `MediaError("unsupported")`.

**Size caps** (after base64 decode): audio ≤ 16 MB, image ≤ 10 MB. Larger files throw `too_large`.

**Storage:**
- Path: `wa/YYYY/MM/<sha256>.<ext>` under the uploads root, with ext `ogg`, `mp3`, `m4a`, `wav`, `jpg`, `png` or `webp`.
- Directories: `mkdir -p` with mode 0o750. Files are written with mode 0o640.
- Write to a temp file first, then `rename`, so writes are atomic.
- If the file already exists (same hash), reuse it.

**Images:** never serve the originals to the browser as HTML. The serving route in task 18 sets `Content-Type` from `media_mime`, `X-Content-Type-Options: nosniff` and `Content-Disposition: inline`.

**Retention:** `purgeExpiredMedia` selects `wa_messages` with `media_path IS NOT NULL AND media_deleted_at IS NULL AND created_at < now - retentionDays`. For each row:
- unlink the file, ignoring ENOENT, but only when no other non-deleted message references the same `media_sha256`
- set `media_deleted_at`
- keep `transcript` and `body`

Process at most 200 rows per call.

**Errors:** a download `WhatsAppError("retryable")` becomes `MediaError("download")`, which the caller retries. A `permanent` one becomes `MediaError("permanent")`.

**Logging:** never log paths that contain phone numbers (there are none by design) or the media content.

## Acceptance Criteria

- [ ] Unit test `scripts/unit/whatsapp-media.test.mjs` (temp uploads dir via the env var `uploads.ts` uses; check which) covers:
  - sniffing each format
  - an expected mismatch is rejected
  - the size cap
  - the same content is stored once
  - path traversal (`../x`) throws
  - `imageForVision` outputs ≤1024 px JPEG
  - purge deletes old files, keeps transcripts and keeps files still referenced by newer messages
- [ ] Lint and tsc pass.
