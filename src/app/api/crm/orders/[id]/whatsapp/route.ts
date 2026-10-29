import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import {
  canAccessConversation,
  getConversation,
  listMessages,
} from "@/lib/services/whatsapp-conversations";
import { getDraft, listProposals } from "@/lib/services/whatsapp-staging";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { id } = await params;

    const db = getDb();
    const order = db
      .prepare("SELECT id, assigned_to FROM orders WHERE id = ?")
      .get(id) as { id: string; assigned_to: string | null } | undefined;
    if (!order) {
      return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
    }

    // Mirrors the order-page access rule: an agent may see the panel only when
    // the order is assigned to them or unassigned; admins see everything.
    if (user.role !== "admin" && order.assigned_to !== null && order.assigned_to !== user.id) {
      return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
    }

    let conversation = null;
    let messages: ReturnType<typeof listMessages> = [];
    const linked = db
      .prepare(
        `SELECT c.id FROM wa_conversations c
         JOIN wa_conversation_orders co ON co.conversation_id = c.id
         WHERE co.order_id = ?
         ORDER BY (co.access = 'full') DESC, c.updated_at DESC
         LIMIT 1`,
      )
      .get(id) as { id: string } | undefined;
    if (linked && canAccessConversation(linked.id, user.id, user.role)) {
      conversation = getConversation(linked.id);
      if (conversation) {
        messages = listMessages(linked.id, { limit: 20, includeUnsent: true });
      }
    }

    const outboxRows = db
      .prepare(
        `SELECT id, purpose, status, sent_at, created_at
         FROM wa_outbox
         WHERE order_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
      )
      .all(id) as Array<{
      id: string;
      purpose: string;
      status: string;
      sent_at: string | null;
      created_at: string;
    }>;

    return NextResponse.json(
      {
        conversation,
        messages,
        draft: getDraft(id),
        proposals: listProposals(id),
        outbox: outboxRows.map((row) => ({
          id: row.id,
          purpose: row.purpose,
          status: row.status,
          sentAt: row.sent_at,
          createdAt: row.created_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
