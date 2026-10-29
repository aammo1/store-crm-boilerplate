import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource } from "../test-source.mjs";

const phone = loadSource("@/lib/whatsapp/phone");
const copy = loadSource("@/lib/whatsapp/copy");
const prefill = loadSource("@/lib/whatsapp/prefill");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("phoneToJid and jidToPhone round-trip for Moroccan numbers", () => {
  const p1 = "+212612345678";
  const jid1 = phone.phoneToJid(p1);
  assert.equal(jid1, "212612345678@s.whatsapp.net");
  assert.equal(phone.jidToPhone(jid1), p1);

  const p2 = "+212712345678";
  const jid2 = phone.phoneToJid(p2);
  assert.equal(jid2, "212712345678@s.whatsapp.net");
  assert.equal(phone.jidToPhone(jid2), p2);

  // Raw local number converts to normalized JID
  assert.equal(phone.phoneToJid("0612345678"), "212612345678@s.whatsapp.net");
  assert.equal(phone.jidToPhone("212612345678@c.us"), p1);
});

test("jidToPhone strips device suffix and rejects groups, broadcast, @lid, and non-Moroccan senders", () => {
  // Device suffix stripped
  assert.equal(phone.jidToPhone("212612345678:12@s.whatsapp.net"), "+212612345678");
  assert.equal(phone.jidToPhone("212712345678:0@c.us"), "+212712345678");

  // Groups return null
  assert.equal(phone.jidToPhone("12036304@g.us"), null);
  assert.equal(phone.isGroupOrBroadcastJid("12036304@g.us"), true);

  // Broadcasts return null
  assert.equal(phone.jidToPhone("status@broadcast"), null);
  assert.equal(phone.jidToPhone("212612345678@broadcast"), null);
  assert.equal(phone.isGroupOrBroadcastJid("status@broadcast"), true);
  assert.equal(phone.isGroupOrBroadcastJid("news@broadcast"), true);

  // Newsletters return null
  assert.equal(phone.jidToPhone("12345@newsletter"), null);
  assert.equal(phone.isGroupOrBroadcastJid("12345@newsletter"), true);

  // Normal user JID is not group or broadcast
  assert.equal(phone.isGroupOrBroadcastJid("212612345678@s.whatsapp.net"), false);
  assert.equal(phone.isGroupOrBroadcastJid("212612345678@c.us"), false);

  // @lid returns null
  assert.equal(phone.jidToPhone("1234567890@lid"), null);

  // Non-Moroccan sender returns null
  assert.equal(phone.jidToPhone("33612345678@s.whatsapp.net"), null);
  assert.equal(phone.jidToPhone("14155552671@s.whatsapp.net"), null);

  // Invalid inputs
  assert.equal(phone.jidToPhone(""), null);
  assert.equal(phone.phoneToJid("+33612345678"), null);
  assert.equal(phone.phoneToJid("invalid"), null);
});

test("orderRefFromOrderId extracts first 8 uppercase characters", () => {
  assert.equal(phone.orderRefFromOrderId("ord_abcdef123456"), "ORD_ABCD");
  assert.equal(phone.orderRefFromOrderId("a1b2c3d4e5f6"), "A1B2C3D4");
  assert.equal(phone.orderRefFromOrderId(""), "");
});

test("ref extraction from text", () => {
  assert.deepEqual(phone.extractOrderRefs("salam #a1b2c3d4 merci"), ["A1B2C3D4"]);
  assert.deepEqual(phone.extractOrderRefs("mon ref A1B2C3D4 sans hash"), ["A1B2C3D4"]);

  // Deduplication and max 3
  const multi = "Ref #A1B2C3D4 et #A1B2C3D4 puis #B2C3D4E5 et #C3D4E5F6 et enfin #D4E5F6G7";
  const extracted = phone.extractOrderRefs(multi);
  assert.deepEqual(extracted, ["A1B2C3D4", "B2C3D4E5", "C3D4E5F6"]);
  assert.equal(extracted.length, 3);

  // Ignored if not 8 characters
  assert.deepEqual(phone.extractOrderRefs("court #A1B2 trop long #A1B2C3D4E5F6"), []);
  assert.deepEqual(phone.extractOrderRefs(""), []);
});

test("extractLast4 finds a standalone 4-digit group", () => {
  assert.equal(phone.extractLast4("mon code 5678 merci"), "5678");
  assert.equal(phone.extractLast4("رقم ٥٦٧٨"), "5678");
  assert.equal(phone.extractLast4("mon numero finit par 1234."), "1234");
  // Not matched if part of longer number
  assert.equal(phone.extractLast4("0612345678"), null);
  assert.equal(phone.extractLast4("123"), null);
  assert.equal(phone.extractLast4("12345"), null);
  assert.equal(phone.extractLast4(""), null);
});

test("maskPhone masks middle digits for UI display", () => {
  assert.equal(phone.maskPhone("+212612345678"), "+212 6•• •• •6 78");
  assert.equal(phone.maskPhone("0612345678"), "+212 6•• •• •6 78");
  assert.equal(phone.maskPhone("+212712345678"), "+212 7•• •• •6 78");
  assert.equal(phone.maskPhone("invalid"), "invalid");
});

test("prefill.ts has zero imports and produces valid variants", () => {
  const prefillPath = path.resolve(__dirname, "../../src/lib/whatsapp/prefill.ts");
  const source = fs.readFileSync(prefillPath, "utf8");
  assert.ok(!source.includes("import "), "prefill.ts must not have any import statements");

  // FR prefill
  const frText1 = prefill.waPrefill("fr", "A1B2C3D4", "seed_order_1");
  const frText1Repeat = prefill.waPrefill("fr", "A1B2C3D4", "seed_order_1");
  assert.equal(frText1, frText1Repeat);
  assert.ok(frText1.includes("#A1B2C3D4"));

  // AR prefill
  const arText1 = prefill.waPrefill("ar", "A1B2C3D4", "seed_order_1");
  assert.ok(arText1.includes("#A1B2C3D4"));

  // Variety across 10 seeds
  const frVariants = new Set();
  const arVariants = new Set();
  for (let i = 0; i < 10; i++) {
    frVariants.add(prefill.waPrefill("fr", "A1B2C3D4", `seed_${i}`));
    arVariants.add(prefill.waPrefill("ar", "A1B2C3D4", `seed_${i}`));
  }
  assert.ok(frVariants.size >= 2, `FR prefill should have >= 2 variants across 10 seeds (got ${frVariants.size})`);
  assert.ok(arVariants.size >= 2, `AR prefill should have >= 2 variants across 10 seeds (got ${arVariants.size})`);
});

test("pickVariant is deterministic and produces distinct texts across seeds", () => {
  const items = ["A", "B", "C"];
  assert.equal(copy.pickVariant(items, "seed-1"), copy.pickVariant(items, "seed-1"));

  const picked = new Set();
  for (let i = 0; i < 10; i++) {
    picked.add(copy.pickVariant(items, `order-${i}`));
  }
  assert.ok(picked.size >= 2);
});

test("message builders: same seed gives same text, different seeds vary", () => {
  const baseCtx = {
    locale: "fr",
    storeName: "Maison Bio",
    assistantName: "Service client Maison Bio",
    firstName: "Salma",
    ref: "A1B2C3D4",
    seed: "seed_fixed",
  };

  const c1 = copy.msgConfirmed({ ...baseCtx, totalMad: 398, itemsSummary: "2× Huile d'Argan" });
  const c2 = copy.msgConfirmed({ ...baseCtx, totalMad: 398, itemsSummary: "2× Huile d'Argan" });
  assert.equal(c1, c2, "same seed must produce identical text");

  const confirmedVariants = new Set();
  for (let i = 0; i < 10; i++) {
    confirmedVariants.add(
      copy.msgConfirmed({
        ...baseCtx,
        seed: `seed_${i}`,
        totalMad: 398,
        itemsSummary: "2× Huile d'Argan",
      })
    );
  }
  assert.ok(
    confirmedVariants.size >= 2,
    `msgConfirmed should produce at least 2 distinct texts across 10 seeds (got ${confirmedVariants.size})`
  );
});

test("no builder output contains the word 'adresse' or an address field", () => {
  const seeds = ["seed1", "seed2", "seed3", "seed4", "seed5"];
  const locales = ["fr", "ar"];

  for (const locale of locales) {
    for (const seed of seeds) {
      const ctx = {
        locale,
        storeName: "Test Boutique",
        assistantName: "Support Test",
        firstName: "Karim",
        ref: "A1B2C3D4",
        seed,
      };

      const outputs = [
        copy.msgConfirmed({ ...ctx, totalMad: 250, itemsSummary: "1× Montre Luxe", cityName: "Rabat" }),
        copy.msgShipped({ ...ctx, trackingNumber: "OZ123456", trackUrl: "https://track.example.com" }),
        copy.msgDelivered(ctx),
        copy.msgOutForDelivery({ ...ctx, totalMad: 250 }),
        copy.msgDeliveryIssue(ctx),
        copy.msgCancelled(ctx),
        copy.msgRelanceNoAnswer(ctx),
        copy.msgStrikeWarning({ ...ctx, level: 1 }),
        copy.msgStrikeWarning({ ...ctx, level: 2 }),
        copy.msgHandoff(ctx),
      ];

      for (const out of outputs) {
        const lower = out.toLowerCase();
        assert.ok(!lower.includes("adresse"), `Message contains 'adresse': ${out}`);
        assert.ok(!lower.includes("address"), `Message contains 'address': ${out}`);
        assert.ok(!out.includes("عنوان"), `Message contains 'عنوان': ${out}`);

        // Lines <= 3
        const lines = out.split("\n");
        assert.ok(lines.length <= 3, `Message has more than 3 lines (${lines.length}): ${out}`);

        // Emojis <= 1
        const emojiRegex = /[\p{Extended_Pictographic}]/gu;
        const emojiMatches = out.match(emojiRegex) ?? [];
        assert.ok(
          emojiMatches.length <= 1,
          `Message has more than 1 emoji (${emojiMatches.length}): ${out}`
        );
      }
    }
  }
});

test("firstName is dropped cleanly when missing or null", () => {
  const ctxWithoutName = {
    locale: "fr",
    storeName: "Test Store",
    assistantName: "Service Client",
    firstName: null,
    ref: "A1B2C3D4",
    seed: "seed_no_name",
  };

  const out = copy.msgRelanceNoAnswer(ctxWithoutName);
  assert.ok(!out.includes("null") && !out.includes("undefined"));
  assert.ok(out.startsWith("Bonjour, ") || out.startsWith("Tentative d'appel") || out.startsWith("Bonjour nous"));

  const confirmed = copy.msgConfirmed({
    ...ctxWithoutName,
    totalMad: 100,
    itemsSummary: "1× Test",
  });
  assert.ok(!confirmed.includes("null") && !confirmed.includes("undefined"));
});

test("admin format matches exactly", () => {
  const confirmedWithActorAndCity = copy.msgAdminConfirmed({
    ref: "A1B2C3D4",
    itemsSummary: "2× Produit X (42)",
    totalMad: 398,
    cityName: "Casablanca",
    actorName: "Salma",
  });
  assert.equal(
    confirmedWithActorAndCity,
    "✅ Confirmée #A1B2C3D4 · 2× Produit X (42) · 398 DH · Casablanca · par Salma"
  );

  const confirmedWithoutActorAndCity = copy.msgAdminConfirmed({
    ref: "A1B2C3D4",
    itemsSummary: "1× Pack Promo",
    totalMad: 199,
    cityName: null,
    actorName: null,
  });
  assert.equal(
    confirmedWithoutActorAndCity,
    "✅ Confirmée #A1B2C3D4 · 1× Pack Promo · 199 DH · — · par —"
  );

  const refusedWithCity = copy.msgAdminRefused({
    ref: "A1B2C3D4",
    totalMad: 398,
    cityName: "Tanger",
  });
  assert.equal(refusedWithCity, "↩️ Refusée #A1B2C3D4 · 398 DH · Tanger");

  const refusedWithoutCity = copy.msgAdminRefused({
    ref: "A1B2C3D4",
    totalMad: 398,
    cityName: null,
  });
  assert.equal(refusedWithoutCity, "↩️ Refusée #A1B2C3D4 · 398 DH · —");

  const autoBlocked = copy.msgAdminAutoBlocked({
    maskedPhone: "+212 6•• •• •6 78",
    reason: "Insultes répétées",
  });
  assert.equal(autoBlocked, "🚫 Client bloqué · +212 6•• •• •6 78 · Raison : Insultes répétées");

  const disconnected = copy.msgAdminDisconnected();
  assert.equal(
    disconnected,
    "⚠️ WhatsApp déconnecté · Veuillez reconnecter l'instance dans les paramètres."
  );
});
