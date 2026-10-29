import { courierProfile, deliveryProviderName } from "@/lib/env";
import type { CourierName } from "./couriers";
import { createMockProvider, type MockProvider } from "./mock";
import { createOzonProvider } from "./ozon";
import type { DeliveryProvider } from "./provider";
import { createSenditProvider } from "./sendit";

export function getProvider(): DeliveryProvider {
  const name = deliveryProviderName();
  if (name === "mock") {
    const profile = courierProfile();
    const g = globalThis as {
      __crmMockProviders?: Partial<Record<CourierName, MockProvider>>;
      __crmMockProvider?: MockProvider;
    };
    g.__crmMockProviders ??= {};
    const provider = (g.__crmMockProviders[profile] ??= createMockProvider({ profile }));
    g.__crmMockProvider = provider;
    return provider;
  }
  if (name === "sendit") return createSenditProvider();
  return createOzonProvider();
}
