import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { getWhatsAppConnectionState } from "@/lib/services/whatsapp-settings";

export const runtime = "nodejs";

/**
 * Nav badge counters. `todo` mirrors the inbox "à traiter" view scoping:
 * admins count everything, agents only conversations linked to their assigned
 * orders or to no assigned order at all.
 */
function todoCount(userId: string, role: "admin" | "agent"): number {
  const db = getDb();
  if (role === "admin") {
    return (
      db.prepare("SELECT COUNT(*) AS count FROM wa_conversations WHERE needs_human = 1").get() as {
        count: number;
      }
    ).count;
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM wa_conversations c
         WHERE c.needs_human = 1
           AND (
             EXISTS (
               SELECT 1 FROM wa_conversation_orders co
               JOIN orders o ON o.id = co.order_id
               WHERE co.conversation_id = c.id AND o.assigned_to = ?
             )
             OR NOT EXISTS (
               SELECT 1 FROM wa_conversation_orders co
               JOIN orders o ON o.id = co.order_id
               WHERE co.conversation_id = c.id AND o.assigned_to IS NOT NULL
             )
           )`,
      )
      .get(userId) as { count: number }
  ).count;
}

export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const db = getDb();

    const uncertain = (
      db.prepare("SELECT COUNT(*) AS count FROM wa_outbox WHERE status = 'uncertain'").get() as {
        count: number;
      }
    ).count;
    const pendingProposals = (
      db.prepare("SELECT COUNT(*) AS count FROM wa_proposals WHERE status = 'pending'").get() as {
        count: number;
      }
    ).count;
    const openRequests = (
      db.prepare("SELECT COUNT(*) AS count FROM wa_requests WHERE status = 'open'").get() as {
        count: number;
      }
    ).count;

    return NextResponse.json(
      {
        todo: todoCount(user.id, user.role),
        uncertain,
        pendingProposals,
        openRequests,
        connection: getWhatsAppConnectionState(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
