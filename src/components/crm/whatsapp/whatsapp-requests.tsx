"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageCircleIcon, ShoppingCartIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  formatCasablancaDateTime,
  formatRelativeTime,
  maskPhoneDisplay,
} from "@/components/crm/whatsapp/format";
import type { WaRequest } from "@/lib/services/whatsapp-staging";

interface WhatsappRequestsProps {
  initialRequests: WaRequest[];
}

export function WhatsappRequests({ initialRequests }: WhatsappRequestsProps) {
  const [requests, setRequests] = useState<WaRequest[]>(initialRequests);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleDismiss(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/crm/whatsapp/requests/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        toast.error(data?.error ?? "Impossible d'ignorer cette demande.");
        return;
      }
      toast.success("Demande WhatsApp ignorée.");
      setRequests((prev) => prev.filter((r) => r.id !== id));
    } catch {
      toast.error("Erreur de connexion au serveur.");
    } finally {
      setBusyId(null);
    }
  }

  function buildCreateOrderUrl(req: WaRequest): string {
    const sp = new URLSearchParams();
    sp.set("waRequest", req.id);
    if (req.customerName) sp.set("name", req.customerName);
    if (req.phone) sp.set("phone", req.phone);
    if (req.cityName) sp.set("city", req.cityName);
    if (req.address) sp.set("address", req.address);
    if (req.items && req.items.length > 0) {
      sp.set(
        "items",
        req.items.map((i) => `${i.variantId}:${i.qty}`).join(","),
      );
    }
    return `/crm/orders/new?${sp.toString()}`;
  }

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <MessageCircleIcon className="size-5 text-[var(--crm-success)]" aria-hidden />
          <h2 className="font-semibold text-xl text-foreground">Demandes WhatsApp</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Clients ayant manifesté leur intention d&apos;achat sur WhatsApp sans finaliser sur la boutique en ligne.
        </p>
      </div>

      {requests.length === 0 ? (
        <p className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Aucune demande WhatsApp en attente.
        </p>
      ) : (
        <ul className="space-y-3">
          {requests.map((req) => {
            const createUrl = buildCreateOrderUrl(req);
            const locationStr = [req.address, req.cityName].filter(Boolean).join(" · ");

            return (
              <li
                key={req.id}
                className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">
                      {req.customerName || "Client WhatsApp"}
                    </span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {maskPhoneDisplay(req.phone)}
                    </span>
                  </div>
                  <span
                    className="text-xs text-muted-foreground"
                    title={formatCasablancaDateTime(req.createdAt)}
                  >
                    {formatRelativeTime(req.createdAt)}
                  </span>
                </div>

                {locationStr ? (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Destination :</span> {locationStr}
                  </p>
                ) : null}

                {req.items && req.items.length > 0 ? (
                  <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Articles demandés
                    </span>
                    <ul className="mt-1 space-y-1 text-sm">
                      {req.items.map((item, idx) => (
                        <li key={`${item.variantId}-${idx}`} className="text-foreground">
                          <span className="font-medium">×{item.qty}</span> {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button asChild className="min-h-9">
                    <Link href={createUrl}>
                      <ShoppingCartIcon className="mr-1.5 size-4" aria-hidden />
                      Créer la commande
                    </Link>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busyId === req.id}
                    onClick={() => handleDismiss(req.id)}
                    className="min-h-9 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="mr-1.5 size-4" aria-hidden />
                    {busyId === req.id ? "Traitement…" : "Ignorer"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
