"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface CrmNavLink {
  href: string;
  label: string;
  adminOnly?: boolean;
}

export const CRM_NAV_LINKS: CrmNavLink[] = [
  { href: "/crm", label: "Tableau de bord" },
  { href: "/crm/orders", label: "Commandes" },
  { href: "/crm/whatsapp", label: "WhatsApp" },
  { href: "/crm/expeditions", label: "Expéditions" },
  { href: "/crm/retours", label: "Retours" },
  { href: "/crm/paniers", label: "Paniers abandonnés" },
  { href: "/crm/stock", label: "Stock" },
  { href: "/crm/depenses", label: "Dépenses pub", adminOnly: true },
  { href: "/crm/encaissements", label: "Encaissements", adminOnly: true },
  { href: "/crm/equipe", label: "Équipe", adminOnly: true },
  { href: "/admin", label: "Catalogue produits", adminOnly: true },
  { href: "/crm/parametres", label: "Paramètres", adminOnly: true },
];

export function getCrmCurrentSectionTitle(pathname: string): string {
  if (pathname === "/crm") return "Tableau de bord";
  const matches = CRM_NAV_LINKS.filter(
    (link) =>
      link.href !== "/crm" &&
      (pathname === link.href || pathname.startsWith(link.href + "/")),
  ).sort((a, b) => b.href.length - a.href.length);

  if (matches.length > 0) {
    return matches[0].label;
  }
  return "Tableau de bord";
}

/**
 * "À traiter" counter for the WhatsApp nav badge, refreshed on mount and every
 * 60 s while the tab is visible. The summary route scopes `todo` per role
 * server-side, so agents get their own count. Fetched only on CRM pages.
 */
function useWhatsAppTodoBadge(pathname: string): number | null {
  const [todo, setTodo] = useState<number | null>(null);

  useEffect(() => {
    if (!pathname.startsWith("/crm")) return undefined;
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/crm/whatsapp/summary", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { todo?: unknown };
        if (!cancelled && typeof data.todo === "number") {
          setTodo(data.todo);
        }
      } catch {
        // réseau indisponible : le prochain cycle réessaie
      }
    }

    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);

  return todo;
}

export interface CrmNavProps {
  isAdmin?: boolean;
  onNavigate?: () => void;
  className?: string;
}

export function CrmNav({ isAdmin = false, onNavigate, className }: CrmNavProps) {
  const pathname = usePathname();
  const todoBadge = useWhatsAppTodoBadge(pathname);

  function isActive(href: string) {
    if (href === "/crm") return pathname === "/crm";
    return pathname === href || pathname.startsWith(href + "/");
  }

  const links = CRM_NAV_LINKS.filter((link) => !link.adminOnly || isAdmin);

  return (
    <nav aria-label="Navigation CRM" className={cn("flex flex-col gap-1", className)}>
      {links.map((link) => {
        const active = isActive(link.href);
        const showBadge = link.href === "/crm/whatsapp" && todoBadge !== null && todoBadge > 0;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none",
              active
                ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {link.label}
            {showBadge && (
              <span
                className={cn(
                  "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                  active ? "bg-background text-foreground" : "bg-primary text-primary-foreground",
                )}
              >
                {todoBadge > 99 ? "99+" : todoBadge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
