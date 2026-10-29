export type Ctx = {
  locale: "fr" | "ar";
  storeName: string;
  assistantName: string;
  firstName?: string | null;
  ref: string;
  seed: string;
};

/**
 * 32-bit FNV-1a hash function for deterministic variation selection.
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Selects a variant deterministically from an array using fnv1a(seed).
 */
export function pickVariant<T>(variants: readonly T[], seed: string): T {
  if (variants.length === 0) {
    throw new Error("pickVariant requires a non-empty array");
  }
  const idx = fnv1a(seed) % variants.length;
  return variants[idx];
}

function cleanFirstName(name?: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function frGreeting(name?: string | null): string {
  const fn = cleanFirstName(name);
  return fn ? `Bonjour ${fn}` : "Bonjour";
}

function arGreeting(name?: string | null): string {
  const fn = cleanFirstName(name);
  return fn ? `مرحباً ${fn}` : "مرحباً";
}

export function msgConfirmed(
  ctx: Ctx & { totalMad: number; itemsSummary: string; cityName?: string | null }
): string {
  const { locale, storeName, firstName, ref, seed, totalMad, itemsSummary } = ctx;
  const fn = cleanFirstName(firstName);
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تم تأكيد طلبكم #${ref} من ${storeName} بنجاح ✅\n${itemsSummary} — ${totalMad} DH عند الاستلام.\nسنوافيكم بتفاصيل الشحن قريباً.`,
          `شكراً لكم! طلبكم #${ref} مؤكد: ${itemsSummary} (${totalMad} DH عند التوصيل).\nستصلكم معلومات التتبع هنا 📦`,
          `${storeName}: تم تأكيد طلبيتكم #${ref} بنجاح.\nالمجموع ${totalMad} DH يُؤدى عند التسليم (${itemsSummary}).\nسنخبركم فور إرسال الطلب 👍`,
        ]
      : [
          `${frGreeting(firstName)}, votre commande #${ref} chez ${storeName} est confirmée ✅\n${itemsSummary} — ${totalMad} DH à payer à la livraison.\nNous vous informons dès l'expédition.`,
          `${fn ? `Merci ${fn} !` : "Merci !"} Commande #${ref} confirmée : ${itemsSummary}, ${totalMad} DH (paiement à la livraison).\nVous recevrez le numéro de suivi ici 👍`,
          `${storeName} : votre commande #${ref} est bien confirmée.\nTotal ${totalMad} DH à la livraison (${itemsSummary}).\nOn vous tient au courant dès l'envoi 📦`,
        ];
  return pickVariant(variants, seed);
}

export function msgShipped(
  ctx: Ctx & { trackingNumber: string; trackUrl: string }
): string {
  const { locale, storeName, firstName, ref, seed, trackingNumber, trackUrl } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تم شحن طلبيتكم #${ref} من ${storeName} 📦\nرقم التتبع: ${trackingNumber}\nتتبعوا مسار الطرد: ${trackUrl}`,
          `طلبكم #${ref} في الطريق إليكم 🚚\nرقم التتبع: ${trackingNumber}\nرابط التتبع: ${trackUrl}`,
          `تم إرسال طلبيتكم #${ref} مع شركة الشحن 📍\nرقم التتبع الخاص بكم: ${trackingNumber}\nللمتابعة: ${trackUrl}`,
        ]
      : [
          `${frGreeting(firstName)}, votre commande #${ref} chez ${storeName} est expédiée 📦\nNuméro de suivi : ${trackingNumber}\nSuivez votre colis : ${trackUrl}`,
          `Votre colis #${ref} est en route 🚚\nN° de suivi : ${trackingNumber}\nSuivi en direct : ${trackUrl}`,
          `Bonne nouvelle ! Votre commande #${ref} vient de partir 📍\nSuivi colis (${trackingNumber}) :\n${trackUrl}`,
        ];
  return pickVariant(variants, seed);
}

export function msgDelivered(ctx: Ctx): string {
  const { locale, storeName, firstName, ref, seed } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تم تسليم طلبيتكم #${ref} بنجاح 🎉\nشكراً لثقتكم في متجر ${storeName}!\nنحن دائماً في خدمتكم.`,
          `تم توصيل طلبكم #${ref} ✅\nنشكركم على اختيار ${storeName}.\nنتمنى أن تنال المنتجات إعجابكم!`,
          `وصلكم طردكم #${ref} بنجاح.\nشكراً جزيلاً لتعاملكم مع ${storeName} 🙏\nيسعدنا خدمتكم في أي وقت.`,
        ]
      : [
          `${frGreeting(firstName)}, votre commande #${ref} a été livrée 🎉\nMerci de votre confiance en ${storeName} !\nN'hésitez pas si vous avez la moindre question.`,
          `Votre commande #${ref} est bien livrée ✅\nToute l'équipe ${storeName} vous remercie.\nÀ très bientôt !`,
          `Colis #${ref} livré avec succès.\nMerci d'avoir choisi ${storeName} 🙏\nNous restons à votre disposition.`,
        ];
  return pickVariant(variants, seed);
}

export function msgOutForDelivery(ctx: Ctx & { totalMad: number }): string {
  const { locale, firstName, ref, seed, totalMad } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، طلبيتكم #${ref} في طريقها إليكم اليوم مع الموزع 🚚\nيرجى تحضير ${totalMad} DH للموزع.\nسيتصل بكم هاتفياً فور وصوله.`,
          `طردكم #${ref} سيصلكم اليوم بإذن الله.\nالمبلغ المطلوب: جهزوا ${totalMad} DH نقداً عند الاستلام 💵\nيرجى البقاء على اتصال بهاتفكم.`,
          `الموزع في طريقه لتوصيل طلبكم #${ref} 🛵\nالمرجو تحضير مبلغ ${totalMad} DH عند التسليم.\nشكراً لتعاونكم.`,
        ]
      : [
          `${frGreeting(firstName)}, votre colis #${ref} est en cours de livraison aujourd'hui 🚚\nPréparez ${totalMad} DH pour le livreur.\nIl vous contactera par téléphone.`,
          `Votre commande #${ref} vous sera livrée aujourd'hui.\nPréparez ${totalMad} DH pour le livreur 💵\nRestez joignable sur ce numéro.`,
          `Le livreur a pris en charge votre commande #${ref} 🛵\nPréparez ${totalMad} DH pour la livraison.\nÀ tout de suite !`,
        ];
  return pickVariant(variants, seed);
}

export function msgDeliveryIssue(ctx: Ctx): string {
  const { locale, firstName, ref, seed } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تعذر على الموزع تسليم طلبيتكم #${ref} ⚠️\nمتى يناسبكم استلام الطرد؟\nيمكنكم الرد مباشرة على هذه الرسالة بتوقيتكم المفضل.`,
          `تعذرت عملية تسليم طلبكم #${ref} اليوم.\nيرجى إخبارنا باليوم أو التوقيت المناسب لكم 📅\nسنقوم بإعادة جدولة التوصيل فوراً.`,
          `لم نتمكن من إيصال طلبيتكم #${ref}.\nما هو الموعد المناسب لكم لإعادة التوصيل؟\nالمرجو الرد هنا لتحديد الموعد 🙏`,
        ]
      : [
          `${frGreeting(firstName)}, le livreur a rencontré une difficulté pour votre colis #${ref} ⚠️\nQuand seriez-vous disponible pour une nouvelle livraison ?\nRépondez simplement à ce message.`,
          `Votre livraison #${ref} n'a pas pu être effectuée aujourd'hui.\nMerci de nous indiquer le créneau qui vous convient le mieux 📅\nNous transmettons au transporteur.`,
          `Petit contretemps pour la livraison de votre commande #${ref}.\nÀ quel moment préférez-vous recevoir votre colis ?\nÉcrivez-nous vos disponibilités ici 🙏`,
        ];
  return pickVariant(variants, seed);
}

export function msgCancelled(ctx: Ctx): string {
  const { locale, storeName, firstName, ref, seed } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تم إلغاء طلبيتكم #${ref} من ${storeName}.\nإذا رغبتم في طلبها لاحقاً فنحن في الخدمة دائماً 🙏\nيومكم سعيد!`,
          `تم تسجيل إلغاء طلبكم #${ref}.\nنبقى دائماً في خدمتكم لأي استفسار في ${storeName}.\nنتمنى رؤيتكم مجدداً.`,
          `${storeName}: نؤكد لكم إلغاء الطلبية #${ref}.\nيمكنكم إعادة الطلب من متجرنا في أي وقت تشاؤون.\nشكراً لكم.`,
        ]
      : [
          `${frGreeting(firstName)}, votre commande #${ref} chez ${storeName} a été annulée.\nN'hésitez pas à nous contacter si vous changez d'avis 🙏\nBonne journée !`,
          `Votre commande #${ref} est désormais annulée.\nNous restons à votre écoute chez ${storeName}.\nAu plaisir de vous revoir.`,
          `${storeName} : nous confirmons l'annulation de votre commande #${ref}.\nVous pouvez recommander sur notre boutique à tout moment.\nÀ bientôt !`,
        ];
  return pickVariant(variants, seed);
}

export function msgRelanceNoAnswer(ctx: Ctx): string {
  const { locale, storeName, firstName, ref, seed } = ctx;
  const fn = cleanFirstName(firstName);
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، حاولنا الاتصال بكم بخصوص طلبيتكم #${ref} من ${storeName}.\nالمرجو الرد هنا لتأكيد طلبكم 🙏`,
          `تعذر علينا الوصول إليكم هاتفياً بشأن الطلبية #${ref} من ${storeName}.\nيمكنكم تأكيد الطلب مباشرة بالرد على هذه الرسالة 🙏`,
          `${arGreeting(firstName)}، نود تأكيد طلبكم #${ref} لدى ${storeName} بعد تعذر الاتصال بكم.\nننتظر ردكم هنا لتأكيد إرسال الطلبية 🙏`,
        ]
      : [
          `${fn ? `Bonjour ${fn}` : "Bonjour"}, nous avons essayé de vous joindre pour votre commande #${ref} chez ${storeName}. Répondez ici pour la confirmer 🙏`,
          `${frGreeting(firstName)}, nous n'avons pas réussi à vous joindre au sujet de votre commande #${ref} chez ${storeName}.\nRépondez directement à ce message pour la confirmer 🙏`,
          `Tentative d'appel pour votre commande #${ref} chez ${storeName}.\nPour éviter l'annulation, répondez-nous ici pour valider votre commande 🙏`,
        ];
  return pickVariant(variants, seed);
}

export function msgStrikeWarning(
  ctx: Omit<Ctx, "ref"> & { level: 1 | 2 }
): string {
  const { locale, storeName, assistantName, firstName, seed, level } = ctx;
  if (level === 1) {
    const variants =
      locale === "ar"
        ? [
            `${arGreeting(firstName)}، نلاحظ تكرار بعض الرسائل غير الملائمة في تواصلكم مع ${storeName} ⚠️\nيرجى الحفاظ على حوار محترم لنتمكن من خدمتكم بشكل أفضل.\nشكراً لتفهمكم.`,
            `تنبيه من خدمة عملاء ${storeName}:\nنرجو منكم الالتزام بالاحترام واللباقة أثناء التواصل مع الفريق ⚠️\nنحن هنا لمساعدتكم ونتمنى تعاونكم.`,
            `رسالة من ${assistantName}:\nتم تسجيل نشاط غير معتاد عبر محادثتكم.\nنرجو الالتزام بشروط الاستخدام حتى نتمكن من الاستمرار في خدمتكم 🙏`,
          ]
        : [
            `${frGreeting(firstName)}, nous constatons un comportement inhabituel sur nos échanges avec ${storeName} ⚠️\nMerci de respecter les règles d'usage pour que nous puissions continuer à vous assister.\nNotre équipe reste à votre écoute.`,
            `Rappel de notre service client ${storeName} :\nMerci de préserver un échange courtois et respectueux avec nos conseillers ⚠️\nNous comptons sur votre compréhension.`,
            `Message de ${assistantName} :\nNous avons détecté des échanges non conformes à nos règles d'utilisation.\nMerci de garder des échanges cordiaux afin de maintenir l'accès à nos services 🙏`,
          ];
    return pickVariant(variants, seed);
  }

  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تحذير أخير من ${storeName} ⛔\nالمخالفة القادمة تعني حظر رقمكم وإلغاء طلباتكم تلقائياً.\nيرجى أخذ هذا التنبيه بعين الاعتبار.`,
          `إنذار نهائي من خدمة العملاء:\nتكرار هذا السلوك غير مقبول في ${storeName}.\nأي تجاوز جديد سيؤدي إلى حظر حسابكم فوراً ⛔`,
          `تنبيه أخير من ${assistantName}:\nنلفت انتباهكم إلى أن المخالفة القادمة ستتسبب في حظر نهائي لرقمكم ⛔\nالمرجو الالتزام بقواعد التعامل.`,
        ]
      : [
          `${frGreeting(firstName)}, dernier avertissement de la part de ${storeName} ⛔\nAu prochain manquement, votre numéro sera automatiquement bloqué.\nMerci d'en prendre note.`,
          `Avertissement final : votre comportement enfreint nos règles chez ${storeName}.\nProchain manquement = blocage de votre numéro et de vos commandes ⛔\nL'équipe du service client.`,
          `Dernier rappel de ${assistantName} :\nTout nouvel abus entraînera un blocage immédiat et sans préavis ⛔\nMerci de vous conformer à nos règles.`,
        ];
  return pickVariant(variants, seed);
}

export function msgHandoff(ctx: Omit<Ctx, "ref">): string {
  const { locale, storeName, firstName, seed } = ctx;
  const variants =
    locale === "ar"
      ? [
          `${arGreeting(firstName)}، تم تحويل طلبكم إلى أحد مستشارينا في ${storeName} 👤\nسيتواصل معكم أحد أعضاء الفريق ويجيبكم قريباً.\nشكراً لصبركم!`,
          `شكراً لرسالتكم. لقد قمت بإحالة محادثتكم إلى مستشار خدمة العملاء في ${storeName}.\nأحد مستشارينا سيجيبكم هنا قريباً جداً ⏱️\nنرجو الانتظار قليلاً.`,
          `تم تحويل استفساركم إلى فريق الدعم في ${storeName}.\nأحد المستشارين سيجيبكم في أقرب وقت عبر هذه المحادثة 🙏\nشكراً لتفهمكم.`,
        ]
      : [
          `${frGreeting(firstName)}, votre demande a bien été transmise à notre équipe 👤\nUn conseiller vous répond bientôt.\nMerci pour votre patience !`,
          `Merci pour votre message. Je transmets votre dossier à un conseiller ${storeName}.\nUn conseiller vous répond bientôt ici même ⏱️\nÀ tout de suite.`,
          `Votre demande nécessite l'intervention d'un conseiller de l'équipe ${storeName}.\nUn conseiller vous répond bientôt sur ce numéro 🙏\nMerci de votre attente.`,
        ];
  return pickVariant(variants, seed);
}

export function msgAdminConfirmed(input: {
  ref: string;
  itemsSummary: string;
  totalMad: number;
  cityName: string | null;
  actorName: string | null;
}): string {
  return `✅ Confirmée #${input.ref} · ${input.itemsSummary} · ${input.totalMad} DH · ${input.cityName ?? "—"} · par ${input.actorName ?? "—"}`;
}

export function msgAdminRefused(input: {
  ref: string;
  totalMad: number;
  cityName: string | null;
}): string {
  return `↩️ Refusée #${input.ref} · ${input.totalMad} DH · ${input.cityName ?? "—"}`;
}

export function msgAdminAutoBlocked(input: {
  maskedPhone: string;
  reason: string;
}): string {
  return `🚫 Client bloqué · ${input.maskedPhone} · Raison : ${input.reason}`;
}

export function msgAdminDisconnected(): string {
  return "⚠️ WhatsApp déconnecté · Veuillez reconnecter l'instance dans les paramètres.";
}
