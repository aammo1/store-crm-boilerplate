import { z } from "@/lib/validation";

export const courierSettingsSchema = z.object({
  senditPickupDistrictId: z.number().int().positive().nullable(),
  senditAllowOpen: z.boolean(),
  senditAllowTry: z.boolean(),
}).strict();

export type CourierSettings = z.infer<typeof courierSettingsSchema>;

export const DEFAULT_COURIER_SETTINGS: CourierSettings = {
  senditPickupDistrictId: null,
  senditAllowOpen: true,
  senditAllowTry: false,
};

export const courierSettingsUpdateSchema = courierSettingsSchema.partial().strict();
export type CourierSettingsUpdate = z.infer<typeof courierSettingsUpdateSchema>;
