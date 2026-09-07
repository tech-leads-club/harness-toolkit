import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENTROPY_THRESHOLD, scanForSecrets, shannonEntropy } from "../secret-scan.service.ts";

test("EFH-07: an AWS access key is matched with kind aws-access-key", () => {
  const matches = scanForSecrets("AWS_KEY=AKIAABCDEFGHIJKLMNOP is set in env");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "aws-access-key");
});

test("EFH-07: a GitHub token is matched with kind github-token", () => {
  const matches = scanForSecrets("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "github-token");
});

test("EFH-07: a Slack token is matched with kind slack-token", () => {
  const matches = scanForSecrets("SLACK_TOKEN=xoxb-1234567890-abcdefghijklmnopqrstuvwx");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "slack-token");
});

test("EFH-07: a Stripe key is matched with kind stripe-key", () => {
  const matches = scanForSecrets("STRIPE_KEY=sk_test_1234567890abcdefghijklmnop");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "stripe-key");
});

test("EFH-07: a PEM private-key block is matched with kind pem-private-key", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAtestkeydata1234567890",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const matches = scanForSecrets(pem);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "pem-private-key");
  assert.equal(matches[0]?.start, 0);
  assert.equal(matches[0]?.end, pem.length);
});

test("EFH-07: a JWT is matched with kind jwt", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QgVXNlciJ9.dGhpc2lzYXRlc3RzaWduYXR1cmU";
  const matches = scanForSecrets(`Authorization: Bearer ${jwt}`);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "jwt");
});

test("EFH-09: a high-entropy unlabelled string above the threshold is matched with kind entropy", () => {
  const matches = scanForSecrets("high entropy secret: Zx9pQr3mNc7VbKq2Lw8Ty1Ue4Ra6Sd0F end");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "entropy");
  assert.ok(shannonEntropy("Zx9pQr3mNc7VbKq2Lw8Ty1Ue4Ra6Sd0F") > ENTROPY_THRESHOLD);
});

test("EFH-09/edge case: a git commit SHA (high-length, low-diversity hex) is a control string that does NOT match", () => {
  const matches = scanForSecrets("commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 looks fine");
  assert.deepEqual(matches, []);
});

test("EFH-09/edge case: a UUID is a control string that does NOT match", () => {
  const matches = scanForSecrets("id: 550e8400-e29b-41d4-a716-446655440000 not a secret");
  assert.deepEqual(matches, []);
});

test("EFH-11: a plain, low-entropy string with no secret-shaped content produces zero matches", () => {
  const matches = scanForSecrets("hello world this is a perfectly ordinary sentence with no secrets at all");
  assert.deepEqual(matches, []);
});

test("empty/undefined input returns [] without throwing", () => {
  assert.doesNotThrow(() => scanForSecrets(undefined));
  assert.deepEqual(scanForSecrets(undefined), []);
  assert.deepEqual(scanForSecrets(""), []);
});

test("no network call, no subprocess spawn: the module imports nothing beyond its own source", () => {
  const source = readFileSync(new URL("../secret-scan.service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|node:http|node:https|\bfetch\(/);
});
