# Custom product sections

Hand-made marketing blocks rendered on both `/produit/[slug]` and `/l/[slug]` when mapped for a product slug.

1. Create a server component in this folder. It receives `{ product, locale }`:

   ```tsx
   // src/custom/my-story.tsx
   import type { CustomSectionProps } from "./index";

   export default function MyStory({ product }: CustomSectionProps) {
     return <section className="rounded-store bg-store-muted p-6">{product.story}</section>;
   }
   ```

2. Register it in `src/custom/index.ts` with a lazy import:

   ```ts
   "my-story": dynamic(() => import("./my-story")),
   ```

3. Map it to one or more products in `store.config.ts`:

   ```ts
   customSections: { "bottines-cadena": ["my-story", "example-feature-grid"] },
   ```

Keys render in the listed order. Unknown keys are skipped (with a warning in development).

## Storefront & JS Budget Rules (Mandatory)
- **Server-only:** Keep sections server-rendered (never add `"use client"`). `/l/[slug]` sits close to the strict **120 KiB gzip** first-load JS budget (`npm run perf-budget`).
- **Never import from `next/image`:** Importing `<Image>` or even `getImageProps` from `"next/image"` pulls the Next.js client image runtime (~5 KiB gzip) into the route bundle and fails `npm run perf-budget`. Use `StoreImage` from `@/components/storefront/ui/store-image` or plain `<img loading="lazy" width={...} height={...}>`.
- **Allowed image paths:** `StoreImage` optimizes local paths matching `/api/media/**`, `/images/**`, or `/brand/**` (see `next.config.ts`). Put any new static section visuals in `public/images/<slug>/` (WebP preferred).
- **Order CTAs & RTL:** Use `href="#commander"` for order anchor CTAs (wired on both `/produit/[slug]` and `/l/[slug]`), match the store's `locale` (`fr` or `ar`) for bespoke section copy (reusing `product`, `store.config.ts` or `src/config/i18n.ts` for shared UI text), and use logical CSS properties (`ms-`, `ps-`, `text-start`) for RTL.
- `example-feature-grid.tsx` is a generic example driven by `product.materials`.
