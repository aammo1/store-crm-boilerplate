import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "../test-source.mjs";

const evolution = loadSource("@/lib/whatsapp/evolution");

const API_KEY = "unit-test-api-key-0123456789abcdef";
const BASE = "https://evolution.internal";
const INSTANCE = "store-one";
const ENV = {
  EVOLUTION_BASE_URL: BASE,
  EVOLUTION_INSTANCE: INSTANCE,
  EVOLUTION_API_KEY: API_KEY,
};

/** Builds a JSON Response the way Evolution would answer. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs globalThis.fetch for the duration of fn, recording every call. */
async function withFetch(handler, fn) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    calls.push(call);
    return handler(call);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = prev;
  }
}

function sender() {
  const s = evolution.getWhatsAppSender(ENV);
  assert.ok(s, "sender must be built when Evolution is configured");
  return s;
}

function assertSecretFree(err) {
  assert.ok(err instanceof evolution.WhatsAppError, `expected WhatsAppError, got: ${err}`);
  const msg = String(err.message);
  assert.ok(!msg.includes(API_KEY), "apiKey must never appear in error messages");
}

test("getWhatsAppSender returns null when unconfigured and a full sender when configured", () => {
  assert.equal(evolution.getWhatsAppSender({}), null);
  assert.equal(
    evolution.getWhatsAppSender({ EVOLUTION_BASE_URL: BASE, EVOLUTION_INSTANCE: INSTANCE }),
    null,
  );
  assert.equal(
    evolution.getWhatsAppSender({ EVOLUTION_BASE_URL: BASE, EVOLUTION_API_KEY: API_KEY }),
    null,
  );

  const s = evolution.getWhatsAppSender(ENV);
  assert.ok(s);
  for (const m of [
    "sendText",
    "sendImage",
    "sendPresence",
    "checkNumbers",
    "getMediaBase64",
    "connectionState",
  ]) {
    assert.equal(typeof s[m], "function", `missing method ${m}`);
  }
});

test("cleanRecipientNumber keeps digits only, strips JID/device suffix and local leading zero", () => {
  assert.equal(evolution.cleanRecipientNumber("+212612345678"), "212612345678");
  assert.equal(evolution.cleanRecipientNumber("212612345678:12@s.whatsapp.net"), "212612345678");
  assert.equal(evolution.cleanRecipientNumber("00212612345678"), "212612345678");
  assert.equal(evolution.cleanRecipientNumber("0612345678"), "212612345678");
  assert.equal(evolution.cleanRecipientNumber(""), "");
});

test("sendText posts to /message/sendText/{instance} with apikey header, digits-only number, no redirects", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(200, { key: { id: "MSG-1" } }), async (calls) => {
    const res = await s.sendText("+212612345678", "Bonjour, votre commande est confirmée");
    assert.equal(res.waMessageId, "MSG-1");

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, `${BASE}/message/sendText/${INSTANCE}`);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.apikey, API_KEY);
    assert.equal(call.init.headers["content-type"], "application/json");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(call.init.body), {
      number: "212612345678",
      text: "Bonjour, votre commande est confirmée",
    });
  });
});

test("sendText accepts a JID with device suffix and falls back to a bare id", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(200, { key: { id: "MSG-2" } }), async (calls) => {
    await s.sendText("212712345678:13@s.whatsapp.net", "salam");
    assert.deepEqual(JSON.parse(calls[0].init.body), { number: "212712345678", text: "salam" });
  });

  await withFetch(() => jsonResponse(200, { id: "ALT-1" }), async () => {
    const res = await s.sendText("212612345678", "re");
    assert.equal(res.waMessageId, "ALT-1");
  });

  await withFetch(() => new Response("", { status: 200 }), async () => {
    const res = await s.sendText("212612345678", "re");
    assert.equal(res.waMessageId, null);
  });
});

test("sendImage posts to /message/sendMedia/{instance} with url or base64 media", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(200, { key: { id: "MSG-3" } }), async (calls) => {
    await s.sendImage(
      "212612345678",
      { url: "https://cdn.internal/img.jpg", mimetype: "image/jpeg", fileName: "img.jpg" },
      "Produit X 199 DH",
    );
    assert.equal(calls[0].url, `${BASE}/message/sendMedia/${INSTANCE}`);
    let body = JSON.parse(calls[0].init.body);
    assert.equal(body.number, "212612345678");
    assert.equal(body.mediatype, "image");
    assert.equal(body.mimetype, "image/jpeg");
    assert.equal(body.media, "https://cdn.internal/img.jpg");
    assert.equal(body.fileName, "img.jpg");
    assert.equal(body.caption, "Produit X 199 DH");

    await s.sendImage(
      "212612345678",
      { base64: "QUJD", mimetype: "image/png", fileName: "p.png" },
      "caption",
    );
    body = JSON.parse(calls[1].init.body);
    assert.equal(body.media, "QUJD");
  });
});

test("sendPresence posts to /chat/sendPresence/{instance} with presence and delay", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(200, {}), async (calls) => {
    await s.sendPresence("212612345678", "composing", 4000);
    assert.equal(calls[0].url, `${BASE}/chat/sendPresence/${INSTANCE}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      number: "212612345678",
      presence: "composing",
      delay: 4000,
    });
  });
});

test("checkNumbers posts to /chat/whatsappNumbers/{instance} and maps exists/jid", async () => {
  const s = sender();
  await withFetch(
    () =>
      jsonResponse(200, [
        { exists: true, jid: "212612345678@s.whatsapp.net", number: "212612345678" },
        { exists: false, number: "212700111222" },
      ]),
    async (calls) => {
      const out = await s.checkNumbers(["+212612345678", "+212700111222"]);
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        numbers: ["212612345678", "212700111222"],
      });
      assert.equal(out.length, 2);
      assert.deepEqual(out[0], {
        phone: "212612345678",
        exists: true,
        jid: "212612345678@s.whatsapp.net",
      });
      assert.deepEqual(out[1], { phone: "212700111222", exists: false, jid: null });
    },
  );
});

test("getMediaBase64 posts the message key and unwraps data: URLs", async () => {
  const s = sender();
  await withFetch(
    () => jsonResponse(200, { base64: "aGVsbG8=", mimetype: "image/jpeg" }),
    async (calls) => {
      const media = await s.getMediaBase64("MSGID9", "212612345678@s.whatsapp.net", false);
      assert.equal(calls[0].url, `${BASE}/chat/getBase64FromMediaMessage/${INSTANCE}`);
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        message: { key: { id: "MSGID9", remoteJid: "212612345678@s.whatsapp.net", fromMe: false } },
        convertToMp4: false,
      });
      assert.deepEqual(media, { base64: "aGVsbG8=", mimetype: "image/jpeg" });
    },
  );

  await withFetch(() => jsonResponse(200, { base64: "data:image/png;base64,QUJD" }), async () => {
    const media = await s.getMediaBase64("MSGID9", "212612345678@s.whatsapp.net", true);
    assert.equal(media.mimetype, "image/png");
    assert.equal(media.base64, "QUJD");
  });
});

test("connectionState GETs /instance/connectionState/{instance} and maps states", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(200, { instance: { state: "open" } }), async (calls) => {
    assert.equal(await s.connectionState(), "open");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, `${BASE}/instance/connectionState/${INSTANCE}`);
  });
  await withFetch(() => jsonResponse(200, { instance: { state: "connecting" } }), async () => {
    assert.equal(await s.connectionState(), "connecting");
  });
  await withFetch(() => jsonResponse(200, { instance: { state: "close" } }), async () => {
    assert.equal(await s.connectionState(), "close");
  });
  await withFetch(() => jsonResponse(200, { instance: { state: "weird" } }), async () => {
    assert.equal(await s.connectionState(), "unknown");
  });
  await withFetch(() => jsonResponse(200, {}), async () => {
    assert.equal(await s.connectionState(), "unknown");
  });
});

test("timeout during a send is unknown; on a non-send it is retryable", async () => {
  const s = sender();
  const timeoutErr = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  await withFetch(() => {
    throw timeoutErr;
  }, async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assertSecretFree(err);
      assert.equal(err.kind, "unknown");
      assert.equal(err.message, "timeout");
      return true;
    });
    await assert.rejects(s.sendPresence("212612345678", "composing", 1000), (err) => {
      assert.equal(err.kind, "retryable");
      return true;
    });
  });
});

test("ECONNREFUSED and DNS failures before the request are retryable", async () => {
  const s = sender();
  await withFetch(
    () => {
      const e = new Error("connect ECONNREFUSED 127.0.0.1:8080");
      e.code = "ECONNREFUSED";
      throw e;
    },
    async () => {
      await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
        assertSecretFree(err);
        assert.equal(err.kind, "retryable");
        assert.equal(err.message, "connection_refused");
        return true;
      });
    },
  );

  await withFetch(
    () => {
      const e = new Error("getaddrinfo ENOTFOUND evolution.internal");
      e.code = "ENOTFOUND";
      throw e;
    },
    async () => {
      await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
        assert.equal(err.kind, "retryable");
        assert.equal(err.message, "dns_failure");
        return true;
      });
    },
  );
});

test("401 and 404 are permanent for sends", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(401, { message: "Unauthorized" }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assertSecretFree(err);
      assert.equal(err.kind, "permanent");
      assert.equal(err.status, 401);
      return true;
    });
  });
  await withFetch(() => jsonResponse(404, { message: "Instance not found" }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assert.equal(err.kind, "permanent");
      assert.equal(err.status, 404);
      return true;
    });
  });
});

test("500 during a send is unknown; on a non-send it is retryable", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(500, { message: "boom" }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assertSecretFree(err);
      assert.equal(err.kind, "unknown");
      assert.equal(err.status, 500);
      return true;
    });
    await assert.rejects(s.connectionState(), (err) => {
      assert.equal(err.kind, "retryable");
      return true;
    });
  });
});

test("429 is retryable with the status preserved", async () => {
  const s = sender();
  await withFetch(() => jsonResponse(429, { message: "Too Many Requests" }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assertSecretFree(err);
      assert.equal(err.kind, "retryable");
      assert.equal(err.status, 429);
      assert.equal(err.message, "rate_limited");
      return true;
    });
  });
});

test("socket reset is unknown for sends and retryable for non-sends", async () => {
  const s = sender();
  await withFetch(
    () => {
      const e = new Error("socket hang up");
      e.code = "ECONNRESET";
      throw e;
    },
    async () => {
      await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
        assert.equal(err.kind, "unknown");
        assert.equal(err.message, "socket_reset");
        return true;
      });
      await assert.rejects(s.connectionState(), (err) => {
        assert.equal(err.kind, "retryable");
        return true;
      });
    },
  );
});

test("an unparseable 2xx body is unknown for sends and retryable for non-sends", async () => {
  const s = sender();
  await withFetch(() => new Response("<<not json>>", { status: 200 }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assert.equal(err.kind, "unknown");
      assert.equal(err.message, "unparseable_response");
      return true;
    });
    await assert.rejects(s.connectionState(), (err) => {
      assert.equal(err.kind, "retryable");
      return true;
    });
  });
});

test("an error body about a number not on WhatsApp is permanent not_on_whatsapp", async () => {
  const s = sender();
  await withFetch(
    () => jsonResponse(400, { error: "The number is not on WhatsApp" }),
    async () => {
      await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
        assertSecretFree(err);
        assert.equal(err.kind, "permanent");
        assert.equal(err.message, "not_on_whatsapp");
        return true;
      });
    },
  );
  await withFetch(() => jsonResponse(400, { exists: false }), async () => {
    await assert.rejects(s.sendText("212612345678", "hi"), (err) => {
      assert.equal(err.kind, "permanent");
      assert.equal(err.message, "not_on_whatsapp");
      return true;
    });
  });
});

test("an oversize media response is rejected as permanent", async () => {
  const s = sender();
  const big = "A".repeat(26 * 1024 * 1024); // 26 MB > 25 MB cap
  await withFetch(
    () => new Response(big, { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(
        s.getMediaBase64("MSGID9", "212612345678@s.whatsapp.net", false),
        (err) => {
          assertSecretFree(err);
          assert.equal(err.kind, "permanent");
          assert.equal(err.message, "media_too_large");
          return true;
        },
      );
    },
  );
});

test("thrown errors never contain the apiKey, the recipient number or the sent text", async () => {
  const s = sender();
  const hostile = `Invalid apikey ${API_KEY} at ${BASE}/message/sendText/${INSTANCE} for +212612345678`;
  await withFetch(() => jsonResponse(403, { message: hostile }), async () => {
    await assert.rejects(s.sendText("+212612345678", "Bonjour, votre commande est confirmée"), (err) => {
      assertSecretFree(err);
      const msg = String(err.message);
      assert.ok(!msg.includes("212612345678"), "phone number must be redacted");
      assert.ok(msg.length <= 300, "error message must be truncated to 300 chars");
      return true;
    });
  });
});
