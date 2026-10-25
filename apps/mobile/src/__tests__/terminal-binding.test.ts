import { ed25519 } from "@noble/curves/ed25519.js";

import { bindServerTerminal } from "@/security/terminal-identity";
import { bytesToBase64, bytesToHex } from "@/security/secure-store";

const TENANT = "00000000-0000-4000-8000-000000000300";
const mockStore = new Map<string, string>();

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
}));
jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(async (size: number) =>
    crypto.getRandomValues(new Uint8Array(size)),
  ),
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("@/mode/mode-store", () => ({
  activeTenantId: () => "00000000-0000-4000-8000-000000000300",
}));

function keyPair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
    publicKeyBase64: bytesToBase64(publicKey),
  };
}

const identityKey = `sewa-motor.terminal-identity.v1.${TENANT}`;
function storeIdentity(
  key: string,
  pair: ReturnType<typeof keyPair>,
  serverTerminalId: string | null,
) {
  mockStore.set(
    key,
    JSON.stringify({
      installationId: "8f4fcf0c-1bf2-4ff3-a809-e8e60b99d618",
      serverTerminalId,
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      enrolledAt: serverTerminalId ? "2026-09-13T14:36:41.000Z" : null,
    }),
  );
}
function storedIdentity() {
  return JSON.parse(mockStore.get(identityKey)!) as {
    serverTerminalId: string | null;
    publicKeyHex: string;
  };
}

beforeEach(() => mockStore.clear());

it("enrolls when the device holds the server terminal's key", async () => {
  const pair = keyPair();
  storeIdentity(identityKey, pair, null);
  await expect(
    bindServerTerminal({ id: "T-1", publicKey: pair.publicKeyBase64 }, TENANT),
  ).resolves.toBe(true);
  expect(storedIdentity()).toMatchObject({
    serverTerminalId: "T-1",
    publicKeyHex: pair.publicKeyHex,
  });
});

it("accepts the server key without base64 padding", async () => {
  const pair = keyPair();
  storeIdentity(identityKey, pair, null);
  await expect(
    bindServerTerminal(
      { id: "T-1", publicKey: pair.publicKeyBase64.replace(/=+$/, "") },
      TENANT,
    ),
  ).resolves.toBe(true);
});

it("restores the retired key of a terminal after the device rotated keys", async () => {
  const original = keyPair();
  const rotated = keyPair();
  storeIdentity(`${identityKey}.retired.T-1`, original, "T-1");
  storeIdentity(identityKey, rotated, null);

  await expect(
    bindServerTerminal(
      { id: "T-1", publicKey: original.publicKeyBase64 },
      TENANT,
    ),
  ).resolves.toBe(true);
  expect(storedIdentity()).toMatchObject({
    serverTerminalId: "T-1",
    publicKeyHex: original.publicKeyHex,
  });
});

it("refuses to sign under a terminal whose key the device does not hold", async () => {
  const server = keyPair();
  const local = keyPair();
  // The broken state seen in production: a rotated key glued to the old ID.
  storeIdentity(identityKey, local, "T-1");

  await expect(
    bindServerTerminal(
      { id: "T-1", publicKey: server.publicKeyBase64 },
      TENANT,
    ),
  ).resolves.toBe(false);
  expect(storedIdentity()).toMatchObject({
    serverTerminalId: null,
    publicKeyHex: local.publicKeyHex,
  });
});
