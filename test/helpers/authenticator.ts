/**
 * TEST-ONLY software authenticator. Produces WebAuthn registration ("none" attestation) and
 * authentication responses that the real @simplewebauthn/server library verifies. Production code
 * contains no WebAuthn cryptography of its own.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

export class SoftwareAuthenticator {
  readonly credentialIdBytes = randomBytes(16);
  readonly credentialId = b64u(this.credentialIdBytes);
  private readonly privateKey: KeyObject;
  readonly cosePublicKey: Uint8Array;
  constructor(public counter = 0, private readonly syncedPasskey = false) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cosePublicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
    ]));
  }

  register(challenge: string, origin: string, rpId: string, opts: { userVerified?: boolean } = {}): RegistrationResponseJSON {
    const flags = 0x01 | 0x40 | (opts.userVerified === false ? 0 : 0x04); // UP | AT | UV
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(), Buffer.from([flags]), u32(0),
      Buffer.alloc(16), Buffer.from([(this.credentialIdBytes.length >> 8) & 255, this.credentialIdBytes.length & 255]),
      this.credentialIdBytes, Buffer.from(this.cosePublicKey),
    ]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    return {
      id: this.credentialId, rawId: this.credentialId, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ["internal"] },
    };
  }

  assert(challenge: string, origin: string, rpId: string, opts: { userVerified?: boolean; counter?: number } = {}): AuthenticationResponseJSON {
    if (!this.syncedPasskey) this.counter += 1;
    const count = opts.counter ?? (this.syncedPasskey ? 0 : this.counter);
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([flags]), u32(count)]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const signature = nodeSign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.privateKey);
    return {
      id: this.credentialId, rawId: this.credentialId, type: "public-key", clientExtensionResults: {},
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(signature) },
    };
  }
}
