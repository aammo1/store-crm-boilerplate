"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { CityCombobox } from "@/components/crm/city-combobox";
import type { CourierSettings, CourierSettingsUpdate } from "@/lib/courier-settings-schema";

export interface CourierSettingsFormProps {
  initialSettings: CourierSettings;
  pickupDistricts: Array<{ id: number; name: string }>;
}

export function CourierSettingsForm({
  initialSettings,
  pickupDistricts: initialPickupDistricts,
}: CourierSettingsFormProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<CourierSettings>(initialSettings);
  const [districts, setDistricts] = useState<Array<{ id: number; name: string }>>(initialPickupDistricts);
  const [pickupDistrictId, setPickupDistrictId] = useState<number | null>(initialSettings.senditPickupDistrictId);
  const [allowOpen, setAllowOpen] = useState<boolean>(initialSettings.senditAllowOpen);
  const [allowTry, setAllowTry] = useState<boolean>(initialSettings.senditAllowTry);
  const [pending, setPending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(initialSettings);
    setPickupDistrictId(initialSettings.senditPickupDistrictId);
    setAllowOpen(initialSettings.senditAllowOpen);
    setAllowTry(initialSettings.senditAllowTry);
  }, [initialSettings]);

  useEffect(() => {
    setDistricts(initialPickupDistricts);
  }, [initialPickupDistricts]);

  async function handleSyncCities() {
    if (syncing) return;
    setSyncing(true);
    try {
      const response = await fetch("/api/crm/cities/sync", { method: "POST" });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; count?: number; error?: string } | null;
      if (!response.ok || !data?.ok) {
        toast.error(data?.error ?? "Échec de la synchronisation des villes.");
        return;
      }
      toast.success(`${data.count ?? 0} villes synchronisées.`);
      const courierRes = await fetch("/api/crm/courier-settings").catch(() => null);
      if (courierRes?.ok) {
        const courierData = (await courierRes.json().catch(() => null)) as {
          pickupDistricts?: Array<{ id: number; name: string }>;
        } | null;
        if (Array.isArray(courierData?.pickupDistricts)) {
          setDistricts(courierData.pickupDistricts);
        }
      }
      router.refresh();
    } catch {
      toast.error("Erreur de connexion lors de la synchronisation des villes.");
    } finally {
      setSyncing(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const changed: CourierSettingsUpdate = {};
    if (pickupDistrictId !== settings.senditPickupDistrictId) {
      changed.senditPickupDistrictId = pickupDistrictId;
    }
    if (allowOpen !== settings.senditAllowOpen) {
      changed.senditAllowOpen = allowOpen;
    }
    if (allowTry !== settings.senditAllowTry) {
      changed.senditAllowTry = allowTry;
    }

    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/crm/courier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });
      const data = (await response.json().catch(() => null)) as {
        settings?: CourierSettings;
        error?: string;
      } | null;
      if (!response.ok) {
        setError(data?.error ?? "Impossible d’enregistrer les réglages Sendit.");
        return;
      }
      if (data?.settings) {
        setSettings(data.settings);
        setPickupDistrictId(data.settings.senditPickupDistrictId);
        setAllowOpen(data.settings.senditAllowOpen);
        setAllowTry(data.settings.senditAllowTry);
      }
      toast.success("Réglages Sendit enregistrés.");
      router.refresh();
    } catch {
      setError("Erreur de connexion. Veuillez réessayer.");
    } finally {
      setPending(false);
    }
  }

  const isPickupMissing = pickupDistrictId === null;

  return (
    <form onSubmit={save} aria-busy={pending} className="flex max-w-3xl flex-col gap-5">
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Transporteur Sendit</h2>
          {isPickupMissing && (
            <Badge variant="destructive" className="h-auto whitespace-normal py-0.5 text-xs">
              Requis — aucun colis Sendit ne partira avant ce choix.
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Ces réglages s&apos;appliquent aux nouveaux colis. Les clés API restent dans les variables d&apos;environnement.
        </p>
      </div>

      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="senditPickupDistrictId">District de ramassage</Label>
          {districts.length === 0 ? (
            <div className="flex flex-col gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              <p>
                Aucun district de ramassage — synchronisez les villes (bouton « Synchroniser les villes » à la confirmation d&apos;une commande, ou redémarrage) puis revenez ici.
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={syncing || pending}
                  onClick={handleSyncCities}
                >
                  {syncing ? "Synchronisation…" : "Synchroniser les villes"}
                </Button>
              </div>
            </div>
          ) : districts.length > 30 ? (
            <CityCombobox
              id="senditPickupDistrictId"
              cities={districts}
              value={pickupDistrictId !== null ? String(pickupDistrictId) : ""}
              onChange={(val) => setPickupDistrictId(val ? Number(val) : null)}
              placeholder="Choisir le district de ramassage…"
              disabled={pending}
            />
          ) : (
            <select
              id="senditPickupDistrictId"
              value={pickupDistrictId !== null ? String(pickupDistrictId) : ""}
              onChange={(e) => setPickupDistrictId(e.target.value ? Number(e.target.value) : null)}
              disabled={pending}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Choisir le district de ramassage…</option>
              {districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Checkbox
              id="senditAllowOpen"
              checked={allowOpen}
              onCheckedChange={(checked) => setAllowOpen(checked === true)}
              disabled={pending}
            />
            <Label htmlFor="senditAllowOpen" className="cursor-pointer text-sm font-medium">
              Autoriser l&apos;ouverture du colis
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Checkbox
              id="senditAllowTry"
              checked={allowTry}
              onCheckedChange={(checked) => setAllowTry(checked === true)}
              disabled={pending}
            />
            <Label htmlFor="senditAllowTry" className="cursor-pointer text-sm font-medium">
              Autoriser l&apos;essayage
            </Label>
          </div>
        </div>
      </fieldset>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <Button type="submit" disabled={pending} className="min-h-11">
          {pending ? "Enregistrement…" : "Enregistrer les réglages"}
        </Button>
      </div>
    </form>
  );
}
