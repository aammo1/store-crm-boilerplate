"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPrice, t, type Locale } from "@/config/i18n";
import { readPendingOrder, type PendingOrder } from "@/stores/funnel";
import { waPrefill } from "@/lib/whatsapp/prefill";

export function ThankYou({ locale, storeSlug, whatsapp }: { locale: Locale; storeSlug: string; whatsapp: string }) {
  const [order, setOrder] = useState<PendingOrder | null>(null);
  useEffect(() => { setOrder(readPendingOrder(storeSlug)); }, [storeSlug]);

  const number = order?.orderId.slice(0, 8).toUpperCase();

  return (
    <div className="space-y-6">
      {order && (
        <section className="rounded-store border border-store-border p-4 text-start">
          <p className="font-semibold">{t(locale, "orderNumber")} : <span dir="ltr">{number}</span></p>
          <ul className="mt-3 space-y-1 text-sm">
            {order.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{l.qty} × {l.name}{l.optionsLabel ? ` (${l.optionsLabel})` : ""}</span>
                <span className="tabular-nums">{formatPrice(locale, l.unitPrice * l.qty)}</span>
              </li>
            ))}
            {!!order.totals.packDiscount && order.totals.packDiscount > 0 && (
              <li className="flex justify-between text-store-accent">
                <span>{t(locale, "packDiscount")}</span>
                <span className="tabular-nums">-{formatPrice(locale, order.totals.packDiscount)}</span>
              </li>
            )}
            <li className="flex justify-between">
              <span>{t(locale, "shipping")}</span>
              <span className="tabular-nums">{order.totals.shipping === 0 ? t(locale, "freeShipping") : formatPrice(locale, order.totals.shipping)}</span>
            </li>
          </ul>
          <p className="mt-3 flex justify-between border-t border-store-border pt-2 font-semibold">
            <span>{t(locale, "total")}</span>
            <span className="tabular-nums">{formatPrice(locale, order.totals.total)}</span>
          </p>
        </section>
      )}

      {order && number ? (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2">
            <a
              href={`https://wa.me/${whatsapp}?text=${encodeURIComponent(waPrefill(locale, number, order.orderId))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2.5 rounded-store bg-store-primary px-6 font-semibold text-store-primary-fg transition hover:opacity-90"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M12.04 2a9.9 9.9 0 0 0-8.5 14.9L2 22l5.25-1.5A9.9 9.9 0 1 0 12.04 2Zm0 18.1c-1.5 0-2.9-.4-4.1-1.1l-.3-.2-3.1.9.9-3-.2-.3a8.1 8.1 0 1 1 6.8 3.7Zm4.5-6.1c-.2-.1-1.5-.8-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1-1.5-.7-2.4-1.3-3.4-2.9-.1-.3.1-.3.3-.6l.4-.5c.1-.2.1-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.8.8-1 1.600-.9 2.500.4 1.800 1.600 3.300 3.500 4.400 2.100 1.200 3 1.100 3.600 1 .6-.1 1.800-.7 2-1.500.3-.7.3-1.300.2-1.500-.1-.1-.3-.2-.5-.3Z" />
              </svg>
              <span>{t(locale, "confirmOnWhatsapp")}</span>
            </a>
            <p className="text-center text-xs text-store-fg/70 sm:text-sm">
              {t(locale, "confirmOnWhatsappHint")}
            </p>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href={`/suivi?ref=${number}`}
              className="inline-flex h-11 w-full sm:w-auto items-center justify-center rounded-store border border-store-border px-6"
            >
              {t(locale, "trackOrder")}
            </Link>
            <Link
              href="/"
              className="inline-flex h-11 w-full sm:w-auto items-center justify-center rounded-store border border-store-border px-6"
            >
              {t(locale, "home")}
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <a
            href={`https://wa.me/${whatsapp}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center rounded-store bg-store-primary px-6 text-store-primary-fg"
          >
            {t(locale, "contactWhatsapp")}
          </a>
          <Link
            href="/"
            className="inline-flex h-11 items-center rounded-store border border-store-border px-6"
          >
            {t(locale, "home")}
          </Link>
        </div>
      )}
    </div>
  );
}
