import type { Metadata } from "next";
import { LeadsWorkspace } from "@/components/crm/leads-workspace";
import { WhatsappRequests } from "@/components/crm/whatsapp/whatsapp-requests";
import { requireUser } from "@/lib/auth-guards";
import { LEAD_RETENTION_DAYS, listOpenLeads } from "@/lib/services/checkout-leads";
import { listOpenRequests } from "@/lib/services/whatsapp-staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Paniers abandonnés · CRM",
  robots: { index: false, follow: false },
};

export default async function LeadsPage() {
  await requireUser();
  const leads = listOpenLeads();
  const requests = listOpenRequests();

  return (
    <div className="space-y-8">
      <WhatsappRequests initialRequests={requests} />
      <LeadsWorkspace initialLeads={leads} retentionDays={LEAD_RETENTION_DAYS} />
    </div>
  );
}
