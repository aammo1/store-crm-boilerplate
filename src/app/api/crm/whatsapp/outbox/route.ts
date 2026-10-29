import { NextResponse } from "next/server";
import { AuthGuardError, requireAdmin } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { z } from "@/lib/validation";

export const runtime = "nodejs";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

interface OutboxIssueRow {
  id: string;
  conversation_id: string | null;
  order_id: string | null;
  phone: string;
  purpose: string;
  kind: string;
  body: string;
  attempts: number;
  status: string;
  last_error: string | null;
  author_user_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  sent_at: string | null;
  updated_at: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();

    const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    const rows = getDb()
      .prepare(
        `SELECT id, conversation_id, order_id, phone, purpose, kind, body, attempts,
                status, last_error, author_user_id, resolved_by, resolved_at,
                created_at, sent_at, updated_at
         FROM wa_outbox
         WHERE status IN ('uncertain', 'failed')
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(parsed.data.limit ?? 50) as OutboxIssueRow[];

    return NextResponse.json(
      {
        items: rows.map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          orderId: row.order_id,
          phone: row.phone,
          purpose: row.purpose,
          kind: row.kind,
          body: row.body,
          attempts: row.attempts,
          status: row.status,
          lastError: row.last_error,
          authorUserId: row.author_user_id,
          resolvedBy: row.resolved_by,
          resolvedAt: row.resolved_at,
          createdAt: row.created_at,
          sentAt: row.sent_at,
          updatedAt: row.updated_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
