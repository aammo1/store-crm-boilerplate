# Custom product sections

Hand-made marketing blocks rendered on `/produit/[slug]`, between the size guide and the reviews.

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
Keep sections server-rendered (no `"use client"`), use plain `<img>` tags with `loading="lazy"` (or `getImageProps` from `next/image` on the server — avoid importing `<Image>` from `next/image` so its client loader isn't added to the 120 KiB JS budget), take all text from the product,
`store.config.ts` or `src/config/i18n.ts`, use `href="#commander"` for order CTAs (supported on both `/produit/[slug]` and `/l/[slug]`), and use logical CSS properties (`ms-`, `ps-`, `text-start`) for RTL.
`example-feature-grid.tsx` is a generic example driven by `product.materials`.
