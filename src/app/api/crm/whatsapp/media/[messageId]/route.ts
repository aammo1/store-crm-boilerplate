import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { canAccessConversation } from "@/lib/services/whatsapp-conversations";
import { getUploadDir } from "@/lib/uploads";

export const runtime = "nodejs";

/**
 * Resolves a stored media relative path under the uploads root.
 * Inline fallback (task-16 will provide src/lib/whatsapp/media.ts): rejects
 * traversal ("..") and absolute components, then verifies the resolved path
 * stays under the root.
 */
function absoluteMediaPath(relPath: string): string | null {
  if (!relPath || relPath.includes("\0")) return null;
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  const root = path.resolve(getUploadDir());
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { messageId } = await params;

    const message = getDb()
      .prepare(
        "SELECT conversation_id, media_path, media_mime, media_deleted_at FROM wa_messages WHERE id = ?",
      )
      .get(messageId) as
      | {
          conversation_id: string;
          media_path: string | null;
          media_mime: string | null;
          media_deleted_at: string | null;
        }
      | undefined;

    // Unknown message, message without media and access denied all answer 404
    // so existence is never revealed.
    if (!message || !message.media_path) {
      return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
    }
    if (!canAccessConversation(message.conversation_id, user.id, user.role)) {
      return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
    }
    if (message.media_deleted_at) {
      return NextResponse.json({ error: "Média expiré (rétention)" }, { status: 410 });
    }

    const filePath = absoluteMediaPath(message.media_path);
    if (!filePath) {
      return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      return NextResponse.json({ error: "Média introuvable." }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": message.media_mime || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
