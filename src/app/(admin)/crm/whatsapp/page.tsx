import type { Metadata } from "next";
import { InboxWorkspace } from "@/components/crm/whatsapp/inbox-workspace";
import { requireUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "WhatsApp · CRM",
  robots: { index: false, follow: false },
};

export default async function WhatsAppInboxPage() {
  const user = await requireUser();
  return <InboxWorkspace role={user.role} userId={user.id} />;
}
