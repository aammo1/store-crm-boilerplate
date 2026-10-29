import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "../test-source.mjs";

const core = loadSource("@/lib/phone-core");
const server = loadSource("@/lib/phone");
const client = loadSource("@/components/storefront/funnel/phone");

const accept = [
  ["0612345678", "+212612345678"], ["06 12 34 56 78", "+212612345678"],
  ["+212612345678", "+212612345678"], ["+212 0612345678", "+212612345678"],
  ["00212612345678", "+212612345678"], ["002120712345678", "+212712345678"],
  ["212712345678", "+212712345678"], ["٠٦١٢٣٤٥٦٧٨", "+212612345678"],
  ["۰۶۱۲۳۴۵۶۷۸", "+212612345678"],
];
const reject = ["0512345678", "061234567", "06123456789", "+33612345678", ""];

test("accepted inputs normalize identically on client and server", () => {
  for (const [input, want] of accept) {
    assert.equal(core.normalizeMaPhoneCore(input), want, input);
    assert.equal(server.normalizeMaPhone(input), want, input);
    assert.equal(client.normalizeMaPhoneClient(input), want, input);
  }
});

test("rejected inputs are rejected identically on client and server", () => {
  for (const input of reject) {
    assert.equal(server.normalizeMaPhone(input), null, input);
    assert.equal(client.normalizeMaPhoneClient(input), null, input);
  }
});

test("toLocalPhone converts +212[5-7]... to 0[5-7]... and keeps others unchanged", () => {
  assert.equal(server.toLocalPhone("+212612345678"), "0612345678");
  assert.equal(server.toLocalPhone("+212712345678"), "0712345678");
  assert.equal(server.toLocalPhone("+212522000000"), "0522000000");
  assert.equal(server.toLocalPhone("+33612345678"), "+33612345678");
  assert.equal(server.toLocalPhone("0612345678"), "0612345678");
});

