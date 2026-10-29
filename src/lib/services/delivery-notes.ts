import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { reconcileBlSchema } from "@/lib/api-schemas";
import { getProvider } from "@/lib/shipping";
import { courierPortal } from "@/lib/shipping/courier-copy";
import { redactSecrets, redactText } from "@/lib/shipping/redact";
import type { DeliveryProvider } from "@/lib/shipping/provider";
import type { z } from "zod";

export type BlStage = "create" | "attach" | "save";
export interface BlHandle { id: string; ref: string; status: string }
export interface BlPdfLinks { standard: string; a4: string; tickets10x10: string }
export interface CreateBlResult {
  created: boolean;
  resumed: boolean;
  bl: BlHandle;
  pdf: BlPdfLinks;
}
export class BlError extends Error {
  readonly status: number;
  readonly stage: BlStage | null;
  readonly bl: BlHandle | null;
  readonly operationId: string | null;
  constructor(status: number, message: string, options: {
    stage?: BlStage; bl?: BlHandle | null; operationId?: string;
  } = {}) {
    super(message);
    this.name = "BlError";
    this.status = status;
    this.stage = options.stage ?? null;
    this.bl = options.bl ?? null;
    this.operationId = options.operationId ?? null;
  }
}
export function blPdfLinks(id: string): BlPdfLinks {
  return {
    standard: `/api/crm/bl/${id}/pdf?format=standard`,
    a4: `/api/crm/bl/${id}/pdf?format=a4`,
    tickets10x10: `/api/crm/bl/${id}/pdf?format=tickets10x10`,
  };
}

type Actor = { id: string; email?: string | null };
interface Operation {
  id: string;
  delivery_note_id: string | null;
  status: "ready" | "running" | "needs_review" | "completed" | "abandoned";
  stage: BlStage | "done";
  revision: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  observed_ref: string | null;
  last_error: string | null;
}
interface Claim { submission_id: string; tracking_number: string; attached_at: string | null }
interface Note { id: string; ref: string; status: string }

// Expiry NEVER authorizes replay. It only allows an agent to reconcile a crashed
// request after the adapter's 15s request deadline has long passed.
const LEASE_MS = 5 * 60_000;
const nowIso = () => new Date().toISOString();
const safeText = (text: string) => redactSecrets(redactText(text), [process.env.OZON_CLIENT_ID ?? "", process.env.OZON_API_KEY ?? ""]);
function operation(id: string): Operation {
  const row = getDb().prepare("SELECT * FROM bl_operations WHERE id = ?").get(id) as Operation | undefined;
  if (!row) throw new BlError(404, "Opération BL introuvable.");
  return row;
}
function claims(id: string): Claim[] {
  return getDb().prepare("SELECT * FROM bl_operation_parcels WHERE operation_id = ? ORDER BY submission_id").all(id) as Claim[];
}
function noteFor(op: Operation): Note | null {
  return op.delivery_note_id
    ? getDb().prepare("SELECT id, ref, status FROM delivery_notes WHERE id = ?").get(op.delivery_note_id) as Note
    : null;
}
function event(op: Operation, kind: string, actor: Actor, detail: string | null = null): void {
  getDb().prepare(`INSERT INTO bl_operation_events (id, operation_id, stage, kind, actor, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`ble_${nanoid(12)}`, op.id, op.stage, kind, actor.id,
    detail, nowIso()); // Callers scrub text BEFORE JSON encoding to preserve valid JSON.
}
function conflict(op: Operation): never {
  throw new BlError(409, op.status === "running"
    ? `Cette opération BL est en cours. Si elle a été interrompue, vérifiez son résultat dans ${courierPortal()} avant de la résoudre.`
    : "Résultat transporteur incertain. Vérifiez et résolvez cette opération dans les expéditions avant de continuer.",
  { operationId: op.id, stage: op.stage === "done" ? undefined : op.stage, bl: noteFor(op) });
}
function validateParcels(ids: string[]): Claim[] {
  const rows = getDb().prepare(`SELECT cs.id AS submission_id, cs.tracking_number, cs.status,
      o.confirmation_status,
      EXISTS (SELECT 1 FROM stock_movements m WHERE m.order_id = o.id AND (m.kind = 'dispatch' OR m.ref LIKE 'disp%')) AS dispatched
      FROM courier_submissions cs JOIN orders o ON o.id = cs.order_id
      WHERE cs.id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<Claim & {
    status: string; confirmation_status: string; dispatched: number;
  }>;
  if (rows.length !== ids.length) throw new BlError(404, "Certains colis sont introuvables.");
  for (const row of rows) {
    if (row.status !== "submitted" || !row.tracking_number || row.confirmation_status !== "confirmed" || row.dispatched) {
      throw new BlError(409, `Le colis ${row.submission_id} n'est pas prêt pour un BL.`);
    }
  }
  return rows;
}
function claimParcels(opId: string, ids: string[]): void {
  const db = getDb();
  for (const row of validateParcels(ids)) {
    if (db.prepare("SELECT 1 FROM bl_operation_parcels WHERE submission_id = ? OR tracking_number = ?").get(row.submission_id, row.tracking_number) ||
        db.prepare("SELECT 1 FROM delivery_note_parcels WHERE submission_id = ?").get(row.submission_id)) {
      throw new BlError(409, "Un colis sélectionné est déjà réservé pour un autre BL.");
    }
    db.prepare(`INSERT INTO bl_operation_parcels (submission_id, operation_id, tracking_number)
      VALUES (?, ?, ?)`).run(row.submission_id, opId, row.tracking_number);
  }
}
function result(op: Operation, created = false): CreateBlResult {
  const note = noteFor(op);
  if (!note || note.status !== "saved") throw new BlError(409, "BL non enregistré.");
  return { created, resumed: !created, bl: note, pdf: blPdfLinks(note.id) };
}

/** Claim the immutable, entire selection BEFORE any external side effect. */
export async function createOrResumeBl(idsInput: string[], actor: Actor, provider?: DeliveryProvider): Promise<CreateBlResult> {
  const ids = [...new Set(idsInput)].sort();
  if (ids.length < 1 || ids.length > 100) throw new BlError(400, "Sélectionnez entre 1 et 100 colis.");
  const db = getDb();
  const selected = db.transaction(() => {
    const existing = db.prepare(`SELECT DISTINCT operation_id FROM bl_operation_parcels
      WHERE submission_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ operation_id: string }>;
    if (existing.length > 1) throw new BlError(409, "Les colis sélectionnés appartiennent à plusieurs opérations BL.");
    if (existing.length === 1) {
      const op = operation(existing[0].operation_id);
      const owned = claims(op.id).map(row => row.submission_id);
      if (owned.length !== ids.length || owned.some((id, index) => id !== ids[index])) {
        throw new BlError(409, "Reprenez la sélection complète de ce BL, sans ajouter ni retirer de colis.", { operationId: op.id });
      }
      return { op, created: false };
    }
    const legacyOrphan = db.prepare(`SELECT id FROM bl_operations op
      WHERE id LIKE 'legacy:%' AND status NOT IN ('completed', 'abandoned')
        AND NOT EXISTS (SELECT 1 FROM bl_operation_parcels p WHERE p.operation_id = op.id)
      LIMIT 1`).get() as { id: string } | undefined;
    if (legacyOrphan) throw new BlError(409,
      "Un ancien BL sans sélection enregistrée doit être vérifié et résolu avant de créer un nouveau BL.",
      { operationId: legacyOrphan.id });
    const id = `blo_${nanoid(12)}`;
    const now = nowIso();
    db.prepare(`INSERT INTO bl_operations (id, status, stage, created_by, created_at, updated_at)
      VALUES (?, 'ready', 'create', ?, ?, ?)`).run(id, actor.id, now, now);
    claimParcels(id, ids);
    const op = operation(id);
    event(op, "claimed", actor);
    return { op, created: true };
  }).immediate();
  if (selected.op.status === "completed") return { ...result(selected.op), resumed: false };
  return runOperation(selected.op.id, actor, provider ?? getProvider(), selected.created);
}

/** Never steals a running/uncertain operation, even when its lease has expired. */
export async function resumeBlOperation(id: string, actor: Actor, provider?: DeliveryProvider): Promise<CreateBlResult> {
  const op = operation(id);
  if (op.status === "completed") return { ...result(op), resumed: false };
  if (op.status === "abandoned") throw new BlError(409, "Cet ancien BL a été clos comme inutilisé.");
  return runOperation(id, actor, provider ?? getProvider(), false);
}
function assertOwned(id: string, token: string): Operation {
  const op = operation(id);
  if (op.status !== "running" || op.lease_token !== token || !op.lease_expires_at || op.lease_expires_at <= nowIso()) conflict(op);
  return op;
}
function persistNote(op: Operation, ref: string, actor: Actor): string {
  if (!ref || ref.length > 128 || !/^[A-Za-z0-9._/-]+$/.test(ref) || redactText(ref) !== ref) throw new BlError(409, "Référence BL invalide.");
  const id = `bl_${nanoid(12)}`;
  // A reference collision is uncertain, NEVER a reason to create another BL.
  getDb().prepare(`INSERT INTO delivery_notes (id, ref, status, created_by, created_at)
    VALUES (?, ?, 'draft', ?, ?)`).run(id, ref, actor.id, nowIso());
  getDb().prepare("UPDATE bl_operations SET delivery_note_id = ?, observed_ref = ? WHERE id = ?").run(id, ref, op.id);
  return id;
}
function persistAttachments(op: Operation, ids: string[]): void {
  if (!op.delivery_note_id) throw new BlError(409, "Référence BL manquante.");
  const db = getDb();
  const now = nowIso();
  for (const id of ids) {
    const existing = db.prepare("SELECT delivery_note_id FROM delivery_note_parcels WHERE submission_id = ?").get(id) as { delivery_note_id: string } | undefined;
    if (existing && existing.delivery_note_id !== op.delivery_note_id) throw new BlError(409, "Colis déjà rattaché à un autre BL.");
    if (!existing) db.prepare(`INSERT INTO delivery_note_parcels (delivery_note_id, submission_id, added_at)
      VALUES (?, ?, ?)`).run(op.delivery_note_id, id, now);
    db.prepare("UPDATE bl_operation_parcels SET attached_at = ? WHERE operation_id = ? AND submission_id = ?").run(now, op.id, id);
  }
}
function saveLocally(op: Operation): void {
  if (!op.delivery_note_id || claims(op.id).length === 0 || claims(op.id).some(row => !row.attached_at)) {
    throw new BlError(409, "Tous les colis doivent être rattachés avant l'enregistrement du BL.");
  }
  getDb().prepare("UPDATE delivery_notes SET status = 'saved', saved_at = ? WHERE id = ?").run(nowIso(), op.delivery_note_id);
}

async function runOperation(id: string, actor: Actor, provider: DeliveryProvider, created: boolean): Promise<CreateBlResult> {
  const db = getDb();
  const token = nanoid(24);
  db.transaction(() => {
    const op = operation(id);
    if (op.status !== "ready") conflict(op);
    const parcels = claims(id);
    if (!parcels.length) throw new BlError(409, `Associez les colis de cet ancien BL après vérification dans ${courierPortal()}.`);
    const current = validateParcels(parcels.map(row => row.submission_id));
    if (current.some(row => parcels.find(p => p.submission_id === row.submission_id)?.tracking_number !== row.tracking_number)) {
      throw new BlError(409, "Les numéros de suivi ont changé : réconciliation nécessaire.");
    }
    db.prepare(`UPDATE bl_operations SET status = 'running', lease_token = ?, lease_expires_at = ?,
      revision = revision + 1, updated_at = ? WHERE id = ?`).run(token, new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), id);
  }).immediate();

  while (true) {
    let observedRef: string | null = null;
    let attempted: Operation | null = null;
    try {
      const op = db.transaction(() => {
        const owned = assertOwned(id, token);
        db.prepare("UPDATE bl_operations SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
          .run(new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), id);
        event(owned, "started", actor);
        return owned;
      }).immediate();
      attempted = op;
      if (op.stage === "create") {
        observedRef = (await provider.createDeliveryNote()).ref;
      } else if (op.stage === "attach") {
        const note = noteFor(op);
        if (!note) throw new BlError(409, "Référence BL manquante.");
        const missing = claims(id).filter(row => !row.attached_at);
        if (missing.length) await provider.addParcelsToDeliveryNote(note.ref, missing.map(row => row.tracking_number));
      } else if (op.stage === "save") {
        const note = noteFor(op);
        if (!note) throw new BlError(409, "Référence BL manquante.");
        await provider.saveDeliveryNote(note.ref);
      }
      const finished = db.transaction(() => {
        const owned = assertOwned(id, token);
        let next: Operation["stage"];
        if (owned.stage === "create") {
          persistNote(owned, observedRef ?? "", actor);
          next = "attach";
        } else if (owned.stage === "attach") {
          persistAttachments(owned, claims(id).filter(row => !row.attached_at).map(row => row.submission_id));
          next = "save";
        } else {
          saveLocally(owned);
          next = "done";
        }
        event(owned, "succeeded", actor);
        db.prepare(`UPDATE bl_operations SET stage = ?, status = ?, revision = revision + 1,
          last_error = NULL, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
          .run(next, next === "done" ? "completed" : "running", next === "done" ? null : token,
            next === "done" ? null : new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), id);
        return operation(id);
      }).immediate();
      if (finished.status === "completed") return result(finished, created);
    } catch (error) {
      // This includes local persistence failures AFTER successful external calls.
      // A killed process leaves 'running', which is equally blocked on restart.
      const detail = safeText(error instanceof Error ? error.message : String(error)).slice(0, 500);
      db.transaction(() => {
        const op = operation(id);
        if (op.status !== "running" || op.lease_token !== token) return; // fenced late response
        event(op, "uncertain", actor, detail);
        db.prepare(`UPDATE bl_operations SET status = 'needs_review', last_error = ?,
          observed_ref = COALESCE(?, observed_ref), lease_token = NULL, lease_expires_at = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(detail,
            observedRef && /^[A-Za-z0-9._/-]{1,128}$/.test(observedRef) && redactText(observedRef) === observedRef ? observedRef : null, nowIso(), id);
      }).immediate();
      throw new BlError(502, `Résultat BL incertain. Les colis restent réservés pour cette opération. Vérifiez ${courierPortal()} puis utilisez « Résoudre ».`,
        { operationId: id, stage: attempted?.stage === "done" ? undefined : attempted?.stage, bl: noteFor(operation(id)) });
    }
  }
}

/** Records portal evidence only; no courier call, no implicit retry. */
export function reconcileBlOperation(id: string, input: z.infer<typeof reconcileBlSchema>, actor: Actor): { operationId: string; status: string } {
  const parsed = reconcileBlSchema.safeParse(input);
  if (!parsed.success) throw new BlError(400, parsed.error.issues[0]?.message ?? "Requête invalide.");
  const data = parsed.data;
  return getDb().transaction(() => {
    const db = getDb();
    const op = operation(id);
    if (op.revision !== data.revision || op.stage !== data.stage) throw new BlError(409, "Cette opération a changé. Actualisez avant de la résoudre.");
    if (op.status !== "needs_review" && !(op.status === "running" && op.lease_expires_at && op.lease_expires_at <= nowIso())) conflict(op);
    if (data.outcome === "unused") {
      if (!id.startsWith("legacy:") || op.stage !== "attach" || claims(id).length || !op.delivery_note_id ||
          noteFor(op)?.status === "saved" || data.submissionIds) {
        throw new BlError(400, "Seul un ancien BL sans sélection peut être clos comme inutilisé après vérification.");
      }
      event(op, "reconciled", actor, JSON.stringify({ outcome: "unused", evidence: safeText(data.evidence) }));
      db.prepare("UPDATE delivery_notes SET status = 'failed' WHERE id = ?").run(op.delivery_note_id);
      db.prepare(`UPDATE bl_operations SET status = 'abandoned', stage = 'done', revision = revision + 1,
        lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id);
      return { operationId: id, status: "abandoned" };
    }
    if (data.outcome === "partial" && op.stage !== "attach") throw new BlError(400, "Un résultat partiel concerne uniquement le rattachement.");
    if (!claims(id).length) {
      if (op.stage !== "attach" || !data.submissionIds) throw new BlError(400, "Sélectionnez les colis de cet ancien BL.");
      claimParcels(id, [...new Set(data.submissionIds)]);
    } else if (data.submissionIds) {
      throw new BlError(400, "La sélection de cette opération est déjà fixée.");
    }
    let next: Operation["stage"] = op.stage;
    if (op.stage === "create") {
      if (data.outcome === "applied") {
        if (!data.ref) throw new BlError(400, "Référence du BL existant requise.");
        if (db.prepare("SELECT 1 FROM delivery_notes WHERE ref = ?").get(data.ref)) throw new BlError(409, "Cette référence BL existe déjà dans le CRM. Vérifiez le conflit avant toute reprise.");
        persistNote(op, data.ref, actor);
        next = "attach";
      }
    } else if (op.stage === "attach") {
      const missing = claims(id).filter(row => !row.attached_at).map(row => row.submission_id);
      const attached = data.outcome === "applied" ? missing : data.outcome === "partial" ? [...new Set(data.attachedSubmissionIds ?? [])] : [];
      if (data.outcome === "partial" && (!attached.length || attached.length >= missing.length || attached.some(value => !missing.includes(value)))) {
        throw new BlError(400, "Indiquez uniquement les colis dont le rattachement a été vérifié (une partie de la sélection).");
      }
      persistAttachments(op, attached);
      next = claims(id).every(row => row.attached_at) ? "save" : "attach";
    } else if (op.stage === "save" && data.outcome === "applied") {
      saveLocally(op);
      next = "done";
    }
    event(op, "reconciled", actor, JSON.stringify({ outcome: data.outcome, evidence: safeText(data.evidence),
      ref: op.stage === "create" ? data.ref : undefined,
      attachedSubmissionIds: op.stage === "attach" ? claims(id).filter(row => row.attached_at).map(row => row.submission_id) : undefined,
      submissionIds: data.submissionIds }));
    db.prepare(`UPDATE bl_operations SET stage = ?, status = ?, revision = revision + 1,
      lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(next, next === "done" ? "completed" : "ready", nowIso(), id);
    return { operationId: id, status: next === "done" ? "completed" : "ready" };
  }).immediate();
}
