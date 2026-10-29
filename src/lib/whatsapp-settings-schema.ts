import { z } from "./validation";

export const whatsappSettingsBaseSchema = z
  .object({
    enabled: z.boolean(), // master kill switch: false => no sends, no AI
    notificationsEnabled: z.boolean(),
    notifyConfirmed: z.boolean(),
    notifyShipped: z.boolean(),
    notifyDelivered: z.boolean(),
    notifyOutForDelivery: z.boolean(),
    notifyDeliveryIssue: z.boolean(),
    notifyCancelled: z.boolean(),
    relanceAfterNoAnswer: z.boolean(),
    relanceNoAnswerCount: z.number().int().min(1).max(5),
    adminAlertsEnabled: z.boolean(),
    adminPhones: z.array(z.string().regex(/^\+212[5-7]\d{8}$/)).max(5),
    adminQuietHours: z.boolean(), // true => admin alerts also respect the window
    sendWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    sendWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    dailyOutboundCap: z.number().int().min(1).max(1000),
    minGapSeconds: z.number().int().min(5).max(600),
    maxGapSeconds: z.number().int().min(5).max(1800),
    aiEnabled: z.boolean(),
    assistantName: z.string().trim().max(60), // "" => "Service client {storeName}"
    faqText: z.string().max(4000),
    aiDailyBudgetCents: z.number().int().min(0).max(10_000), // USD cents; 0 => AI never called
    aiResumeAfterHours: z.number().int().min(1).max(168),
    autoBlockEnabled: z.boolean(),
    catalogSuggestionsEnabled: z.boolean(),
    crossSellEnabled: z.boolean(),
    orderEditProposalsEnabled: z.boolean(),
    mediaRetentionDays: z.number().int().min(7).max(365),
  })
  .strict();

export const whatsappSettingsSchema = whatsappSettingsBaseSchema
  .refine((s) => s.minGapSeconds <= s.maxGapSeconds, {
    message: "Écart minimum supérieur au maximum.",
    path: ["minGapSeconds"],
  })
  .refine((s) => s.sendWindowStart < s.sendWindowEnd, {
    message: "L’heure de début d’envoi doit précéder l’heure de fin.",
    path: ["sendWindowStart"],
  });

export const whatsappSettingsUpdateSchema = whatsappSettingsBaseSchema.partial().strict();

export type WhatsAppSettings = z.infer<typeof whatsappSettingsSchema>;
export type WhatsAppSettingsUpdate = z.infer<typeof whatsappSettingsUpdateSchema>;

export const DEFAULT_WHATSAPP_SETTINGS: Readonly<WhatsAppSettings> = Object.freeze({
  enabled: false,
  notificationsEnabled: false,
  notifyConfirmed: true,
  notifyShipped: true,
  notifyDelivered: true,
  notifyOutForDelivery: true,
  notifyDeliveryIssue: true,
  notifyCancelled: false,
  relanceAfterNoAnswer: true,
  relanceNoAnswerCount: 2,
  adminAlertsEnabled: true,
  adminPhones: [] as string[],
  adminQuietHours: false,
  sendWindowStart: "09:00",
  sendWindowEnd: "21:00",
  dailyOutboundCap: 40,
  minGapSeconds: 30,
  maxGapSeconds: 120,
  aiEnabled: false,
  assistantName: "",
  faqText: "",
  aiDailyBudgetCents: 100,
  aiResumeAfterHours: 12,
  autoBlockEnabled: false,
  catalogSuggestionsEnabled: false,
  crossSellEnabled: false,
  orderEditProposalsEnabled: false,
  mediaRetentionDays: 90,
});

export type WhatsAppConnectionStateValue = "open" | "connecting" | "close" | "unknown";

export interface WhatsAppConnectionState {
  state: WhatsAppConnectionStateValue;
  updatedAt: string | null;
}
