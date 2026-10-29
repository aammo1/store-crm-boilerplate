import { courierProfile } from "@/lib/env";
import { COURIERS } from "./couriers";

export function courierLabel(): string {
  return COURIERS[courierProfile()].label;
}

/** "le portail Ozon Express" / "le portail Sendit" */
export function courierPortal(): string {
  return `le portail ${courierLabel()}`;
}
