import { NextResponse } from "next/server";
import { AuthGuardError, requireUser } from "@/lib/auth-guards";
import { getDb } from "@/lib/db";
import { readLimitedJson, RequestBodyError } from "@/lib/request-body";
import {
  canAccessConversation,
  getConversation,
  linkOrderByAgent,
} from "@/lib/services/whatsapp-conversations";
import { z } from "@/lib/validation";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;

const linkBody = z
  .object({
    orderRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{8}$/, "Référence commande invalide (8 caractères).")
      .optional(),
    orderId: z.string().trim().min(1, "Commande requise.").max(64).optional(),
  })
  .refine((body) => Boolean(body.orderId ?? body.orderRef), {
    message: "Référence commande ou identifiant requis.",
  });

/** LIKE wildcards in the ref must match literally, not as patterns. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { id } = await params;

    // Access denied and unknown conversations both answer 404 so existence is never revealed.
    if (!canAccessConversation(id, user.id, user.role)) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }
    const conversation = getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation introuvable." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await readLimitedJson(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
    }
    const parsed = linkBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Requête invalide" },
        { status: 400 },
      );
    }

    // Any agent may link: identity is verified by phone call, not by assignment.
    const db = getDb();
    let orderId = parsed.data.orderId ?? null;
    if (!orderId) {
      const ref = parsed.data.orderRef!.toUpperCase();
      const matches = db
        .prepare("SELECT id FROM orders WHERE upper(id) LIKE ? ESCAPE '\\'")
        .all(`${escapeLike(ref)}%`) as Array<{ id: string }>;
      if (matches.length === 0) {
        return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
      }
      if (matches.length > 1) {
        return NextResponse.json(
          { error: "Référence ambiguë : plusieurs commandes correspondent. Utilisez l'identifiant." },
          { status: 409 },
        );
      }
      orderId = matches[0].id;
    } else {
      const exists = db.prepare("SELECT 1 FROM orders WHERE id = ?").get(orderId);
      if (!exists) {
        return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
      }
    }

    linkOrderByAgent(id, orderId);
    return NextResponse.json({ ok: true, conversation: getConversation(id) });
  } catch (error) {
    if (error instanceof AuthGuardError) return error.toResponse();
    throw error;
  }
}
