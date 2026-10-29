"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface BlockedPhoneRow {
  phone: string;
  reason: string;
  createdAt: string;
  createdByName: string | null;
  source?: "agent" | "system";
}

export function BlocklistManager({ initialBlocked }: { initialBlocked: BlockedPhoneRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initialBlocked);
  const [removing, setRemoving] = useState<string | null>(null);
  const busy = useRef(false);

  async function remove(phone: string) {
    if (busy.current) return;
    if (!window.confirm(`Débloquer ${phone} ?`)) return;
    busy.current = true;
    setRemoving(phone);
    try {
      const response = await fetch(`/api/crm/blocklist/${encodeURIComponent(phone)}`, { method: "DELETE" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(data?.error ?? "Erreur lors du déblocage.");
        return;
      }
      setRows((current) => current.filter((row) => row.phone !== phone));
      toast.success("Numéro débloqué.");
      router.refresh();
    } catch {
      toast.error("Erreur lors du déblocage.");
    } finally {
      busy.current = false;
      setRemoving(null);
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun numéro bloqué.</p>;
  }

  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((row) => (
        <li key={row.phone} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-foreground">{row.phone}</span>
              {row.source === "system" && (
                <Badge variant="secondary">Auto · système</Badge>
              )}
            </div>
            <p className="break-words text-muted-foreground">
              {row.reason}
              {row.createdByName ? ` · ${row.createdByName}` : ""}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={removing !== null}
            onClick={() => remove(row.phone)}
          >
            {removing === row.phone ? "Suppression…" : "Débloquer"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
