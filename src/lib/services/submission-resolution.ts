import { nanoid } from "nanoid";
import { z } from "@/lib/validation";
import { getDb } from "@/lib/db";
import { redactText } from "@/lib/shipping/redact";
import { insertContact } from "@/lib/services/orders";
import { notifyOrderShipped } from "@/lib/whatsapp/notify";

/** Agent identity as provided by the auth session (only `id` is required). */
export interface ResolutionActor {
  id: string;
  name?: string | null;
}

export class SubmissionResolutionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SubmissionResolutionError";
  }
}

const evidenceField = z
  .string()
  .trim()
  .min(10, "Décrivez la vérification effectuée chez le transporteur (portail ou support).")
  .max(1000);

export const resolveSubmissionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("parcel_exists"),
    trackingNumber: z
      .string({ required_error: "Indiquez le numéro de suivi du portail." })
      .trim()
      .min(3, "Numéro de suivi invalide.")
      .max(64, "Numéro de suivi invalide.")
      .regex(/^[A-Za-z0-9._-]+$/, "Indiquez un numéro de suivi, pas une URL."),
    evidence: evidenceField,
  }),
  z.object({
    outcome: z.literal("no_parcel"),
    evidence: evidenceField,
  }),
]);

export type ResolveSubmissionInput = z.infer<typeof resolveSubmissionSchema>;

export interface ResolveSubmissionResult {
  submissionId: string;
  orderId: string;
  outcome: ResolveSubmissionInput["outcome"];
  status: "submitted" | "queued";
}

interface SubmissionState {
  id: string;
  order_id: string;
  status: string;
}

/**
 * Guarded, attributed resolution of a `needs_review` / `failed` submission,
 * replacing the manual SQL edits of the old runbook. The agent must have
 * verified the courier portal first (evidence is mandatory and stored):
 *
 * - `parcel_exists`: attach the portal's tracking number and mark `submitted`
 *   (no new parcel is ever created).
 * - `no_parcel`: requeue the job so the worker creates the parcel — legitimate
 *   only after portal verification (src/lib/shipping/POLICY.md).
 *
 * One immediate transaction enforces: order confirmed & not cancelled, stock
 * still reserved (not consumed/released), no other active or submitted job for
 * the order, and a tracking number not already used by another submission.
 */
export function resolveSubmission(
  submissionId: string,
  input: ResolveSubmissionInput,
  actor: ResolutionActor,
): ResolveSubmissionResult {
  const db = getDb();
  return db
    .transaction((): ResolveSubmissionResult => {
      const submission = db
        .prepare("SELECT id, order_id, status FROM courier_submissions WHERE id = ?")
        .get(submissionId) as SubmissionState | undefined;
      if (!submission) {
        throw new SubmissionResolutionError(404, "Soumission introuvable.");
      }
      if (submission.status !== "needs_review" && submission.status !== "failed") {
        throw new SubmissionResolutionError(
          409,
          "Seules les soumissions « À vérifier » ou « Échec » peuvent être résolues.",
        );
      }

      const order = db
        .prepare("SELECT confirmation_status FROM orders WHERE id = ?")
        .get(submission.order_id) as { confirmation_status: string } | undefined;
      if (!order) throw new SubmissionResolutionError(404, "Commande introuvable.");
      if (order.confirmation_status !== "confirmed") {
        throw new SubmissionResolutionError(
          409,
          "La commande doit être confirmée (et non annulée) pour résoudre sa soumission.",
        );
      }

      const reservations = db
        .prepare("SELECT status FROM reservations WHERE order_id = ?")
        .all(submission.order_id) as { status: string }[];
      if (
        reservations.length === 0 ||
        reservations.some((r) => r.status !== "active")
      ) {
        throw new SubmissionResolutionError(
          409,
          "Le stock de cette commande n'est plus réservé — résolution impossible.",
        );
      }

      const others = db
        .prepare(
          "SELECT status FROM courier_submissions WHERE order_id = ? AND id != ?",
        )
        .all(submission.order_id, submission.id) as { status: string }[];
      if (others.some((o) => ["queued", "submitting", "submitted"].includes(o.status))) {
        throw new SubmissionResolutionError(
          409,
          "Un autre envoi est déjà actif pour cette commande.",
        );
      }

      const now = new Date().toISOString();
      let trackingNumber: string | null = null;
      if (input.outcome === "parcel_exists") {
        trackingNumber = input.trackingNumber;
        const taken = db
          .prepare(
            "SELECT 1 FROM courier_submissions WHERE tracking_number = ? AND id != ?",
          )
          .get(trackingNumber, submission.id);
        if (taken) {
          throw new SubmissionResolutionError(
            409,
            "Ce numéro de suivi est déjà associé à un autre envoi.",
          );
        }
        db.prepare(
          `UPDATE courier_submissions
           SET status = 'submitted', tracking_number = ?, updated_at = ?
           WHERE id = ?`,
        ).run(trackingNumber, now, submission.id);
        // Same outbox key as the worker's success path: never a second shipped message.
        notifyOrderShipped(submission.order_id, trackingNumber);
      } else {
        db.prepare(
          `UPDATE courier_submissions
           SET status = 'queued', next_retry_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(now, now, submission.id);
      }

      const evidence = redactText(input.evidence);
      db.prepare(
        `INSERT INTO submission_resolutions
           (id, submission_id, order_id, outcome, previous_status, tracking_number, evidence, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `res_${nanoid(12)}`,
        submission.id,
        submission.order_id,
        input.outcome,
        submission.status,
        trackingNumber,
        evidence,
        actor.id,
        now,
      );
      insertContact({
        orderId: submission.order_id,
        agentId: actor.id,
        channel: "note",
        outcome: "note",
        note:
          input.outcome === "parcel_exists"
            ? `Soumission transporteur résolue : colis existant (suivi ${trackingNumber}). ${evidence}`
            : `Soumission transporteur résolue : aucun colis sur le portail, renvoi en file. ${evidence}`,
      });

      return {
        submissionId: submission.id,
        orderId: submission.order_id,
        outcome: input.outcome,
        status: input.outcome === "parcel_exists" ? "submitted" : "queued",
      };
    })
    .immediate();
}
