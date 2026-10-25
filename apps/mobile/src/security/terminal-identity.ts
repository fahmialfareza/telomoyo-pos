import { ed25519 } from "@noble/curves/ed25519.js";
import * as Crypto from "expo-crypto";

import { canonicalize } from "@/utils/canonical-json";
import { activeTenantId } from "@/mode/mode-store";

import {
  bytesToHex,
  bytesToBase64,
  hexToBytes,
  readTerminalIdentity,
  writeTerminalIdentity,
  getOrCreateInstallationId,
  preserveTerminalIdentity,
  readRetiredTerminalIdentity,
  type TerminalIdentityRecord,
} from "./secure-store";

export async function getOrCreateTerminalIdentity(
  tenantId: string = activeTenantId(),
): Promise<TerminalIdentityRecord> {
  const existing = await readTerminalIdentity(tenantId);
  if (existing) return existing;

  const privateKey = await Crypto.getRandomBytesAsync(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  const identity: TerminalIdentityRecord = {
    installationId: await getOrCreateInstallationId(),
    serverTerminalId: null,
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
    enrolledAt: null,
  };
  await writeTerminalIdentity(identity, tenantId);
  return identity;
}

export async function markTerminalEnrolled(
  serverTerminalId: string,
  tenantId: string = activeTenantId(),
): Promise<void> {
  const identity = await getOrCreateTerminalIdentity(tenantId);
  await writeTerminalIdentity(
    {
      ...identity,
      serverTerminalId,
      enrolledAt: new Date().toISOString(),
    },
    tenantId,
  );
}

export async function markTerminalRevoked(
  serverTerminalId: string,
  tenantId: string = activeTenantId(),
): Promise<void> {
  const identity = await getOrCreateTerminalIdentity(tenantId);
  if (identity.serverTerminalId !== serverTerminalId) return;
  await preserveTerminalIdentity(identity, tenantId);
  const privateKey = await Crypto.getRandomBytesAsync(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  await writeTerminalIdentity(
    {
      installationId: identity.installationId,
      serverTerminalId: null,
      privateKeyHex: bytesToHex(privateKey),
      publicKeyHex: bytesToHex(publicKey),
      enrolledAt: null,
    },
    tenantId,
  );
}

function sameBase64Key(publicKeyHex: string, serverPublicKey: string): boolean {
  const strip = (value: string) => value.replace(/=+$/, "");
  return (
    strip(bytesToBase64(hexToBytes(publicKeyHex))) === strip(serverPublicKey)
  );
}

/**
 * Adopts a terminal the server matched by installation ID only when this
 * device holds that terminal's private key. Login does not check keys, so
 * after a key rotation (e.g. a login that briefly found no terminal) blindly
 * adopting the server ID would sign every operation with the wrong key and the
 * server would reject them all with INVALID_TERMINAL_SIGNATURE.
 *
 * Returns true when the device is enrolled with a matching key, restoring the
 * retired key for that terminal if it was rotated away.
 */
export async function bindServerTerminal(
  terminal: { id: string; publicKey: string },
  tenantId: string = activeTenantId(),
): Promise<boolean> {
  const current = await getOrCreateTerminalIdentity(tenantId);
  if (sameBase64Key(current.publicKeyHex, terminal.publicKey)) {
    await markTerminalEnrolled(terminal.id, tenantId);
    return true;
  }
  const retired = await readRetiredTerminalIdentity(tenantId, terminal.id);
  if (retired && sameBase64Key(retired.publicKeyHex, terminal.publicKey)) {
    await writeTerminalIdentity(
      {
        ...retired,
        serverTerminalId: terminal.id,
        enrolledAt: retired.enrolledAt ?? new Date().toISOString(),
      },
      tenantId,
    );
    return true;
  }
  // No local key matches: never sign under this terminal ID.
  if (current.serverTerminalId === terminal.id) {
    await writeTerminalIdentity(
      { ...current, serverTerminalId: null, enrolledAt: null },
      tenantId,
    );
  }
  return false;
}

export async function signCanonicalPayload(
  value: unknown,
  tenantId: string = activeTenantId(),
): Promise<string> {
  const identity = await getOrCreateTerminalIdentity(tenantId);
  return signCanonicalPayloadWithKey(value, hexToBytes(identity.privateKeyHex));
}

export function signCanonicalPayloadWithKey(
  value: unknown,
  privateKey: Uint8Array,
): string {
  const message = new TextEncoder().encode(canonicalize(value));
  const signature = ed25519.sign(message, privateKey);
  return bytesToBase64(signature);
}

export async function getTerminalPublicKeyBase64(
  tenantId: string = activeTenantId(),
): Promise<string> {
  const identity = await getOrCreateTerminalIdentity(tenantId);
  return bytesToBase64(hexToBytes(identity.publicKeyHex));
}
