import { z } from "./validation";
// --- CRM

export const crmOrderListQuerySchema = z.object({
  archived: z.enum(["0", "1"]).optional().transform((value) => value === "1"),
  status: z
    .enum(["new", "no_answer", "call_back_later", "confirmed", "cancelled", "all"])
    .optional(),
  q: z.string().trim().max(120).optional(),
  assignedTo: z.string().trim().max(64).optional(),
  utm_source: z.string().trim().max(200).optional(),
  utm_campaign: z.string().trim().max(200).optional(),
  callbackDue: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  // Comma-separated courier submission statuses (dashboard cards link here);
  // unknown values are dropped rather than rejected.
  submission: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const allowed = new Set([
        "queued",
        "submitting",
        "submitted",
        "failed",
        "needs_review",
      ]);
      const list = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => allowed.has(part));
      return list.length > 0 ? list : undefined;
    }),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
});

export const contactEntrySchema = z
  .object({
    channel: z.enum(["whatsapp", "phone", "note"]),
    outcome: z.enum(["no_answer", "call_back_later", "note", "confirmed_info"]),
    note: z.string().trim().max(2000).optional(),
    next_callback_at: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const raw = data.next_callback_at?.trim();
    if (data.outcome === "call_back_later") {
      if (!raw) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Date de rappel requise",
          path: ["next_callback_at"],
        });
        return;
      }
    }
    if (raw && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Date de rappel invalide",
        path: ["next_callback_at"],
      });
    }
  });

export const assignOrderSchema = z.object({
  agentId: z
    .string()
    .trim()
    .min(1, "Agent requis")
    .max(64)
    .refine((value) => value === "me" || value.startsWith("user_"), {
      message: "Agent invalide",
    }),
});

export const confirmOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        lineIndex: z.number().int().min(0),
        variantId: z.string().trim().min(1, "Variante requise").max(200),
      }).strict(),
    )
    .max(100, "Trop de lignes."),
  address: z
    .string()
    .trim()
    .min(1, "Adresse requise")
    .max(500, "Adresse trop longue"),
  cityId: z.number().int().min(1, "Ville requise"),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.lines.map((line) => line.lineIndex)).size !== input.lines.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "Ligne en double." });
  }
});

export const cancelOrderSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Veuillez indiquer un motif d'annulation.")
    .max(2000, "Motif trop long"),
});

export const orderLineUpdateSchema = z.object({
  lineIndex: z.number().int().min(0),
  variantId: z.string().trim().min(1, "Variante requise").max(200),
}).strict();

export const createBlSchema = z.object({
  submissionIds: z
    .array(z.string().trim().min(1, "Colis requis").max(64))
    .min(1, "Sélectionnez au moins un colis.")
    .max(100, "Trop de colis sélectionnés (100 maximum)."),
});

export const reconcileBlSchema = z.object({
  revision: z.number().int().min(0),
  stage: z.enum(["create", "attach", "save"]),
  outcome: z.enum(["applied", "not_applied", "partial", "unused"]),
  evidence: z.string().trim().min(10, "Décrivez la vérification effectuée chez le transporteur (portail ou support).").max(1000),
  ref: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._/-]+$/, "Indiquez une référence BL, pas une URL.").optional(),
  attachedSubmissionIds: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  // Only for legacy orphan drafts whose original selection was not persisted.
  submissionIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional(),
});

// The parcel id lives in the path; an optional body parcelId is tolerated for
// ergonomics and must match it.
export const parcelHandoffSchema = z.object({
  parcelId: z.string().trim().min(1).max(64).optional(),
});

export const parcelsHandoffSchema = z.object({
  parcelIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
});

// --- CRM retours / stock (task-16)

export { stockBatchSchema } from "./services/inventory-schemas";

export const inspectReturnSchema = z.object({
  lines: z
    .array(
      z.object({
        lineIndex: z.number().int().min(0),
        sellable: z.number().int("Quantité invalide").min(0, "Quantité invalide"),
        damaged: z.number().int("Quantité invalide").min(0, "Quantité invalide"),
      }),
    )
    .min(1, "Aucune ligne à inspecter"),
  reason: z
    .string({ required_error: "Veuillez indiquer le motif du retour." })
    .trim()
    .min(1, "Veuillez indiquer le motif du retour.")
    .max(500, "Motif trop long"),
});

const stockOpeningItemSchema = z.object({
  variantId: z.string().trim().min(1, "Variante requise").max(64),
  qty: z
    .number()
    .int("Quantité invalide")
    .min(0, "Quantité invalide")
    .max(10_000, "Quantité trop élevée"),
});

// Single ({ variantId, qty }) or bulk ({ items: [...] }) opening counts.
export const stockOpeningSchema = z.union([
  stockOpeningItemSchema,
  z.object({
    items: z
      .array(stockOpeningItemSchema)
      .min(1, "Aucune variante à ouvrir")
      .max(500, "Trop de variantes en une seule requête"),
  }),
]);

export const stockAdjustSchema = z
  .object({
    variantId: z.string().trim().min(1, "Variante requise").max(64),
    requestId: z.string().uuid("Identifiant de requête invalide").optional(),
    physicalDelta: z.number().int("Delta invalide").optional(),
    quarantineDelta: z.number().int("Delta invalide").optional(),
    reason: z.string().trim().min(1, "Motif requis").max(500, "Motif trop long"),
  })
  .refine(
    (data) => (data.physicalDelta ?? 0) !== 0 || (data.quarantineDelta ?? 0) !== 0,
    { message: "Indiquez au moins un delta (physique ou quarantaine)" },
  );
