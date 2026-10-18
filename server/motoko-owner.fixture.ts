import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
export class SoftwareAuthenticator {
  readonly id = randomBytes(24).toString("base64url");
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  counter = 0;
  registration(challenge: string, origin = "http://localhost", rpId = "localhost", uv = true): RegistrationResponseJSON {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const id = Buffer.from(this.id, "base64url"), length = Buffer.alloc(2); length.writeUInt16BE(id.length);
    const authData = Buffer.concat([hash(rpId), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), length, id, cose]);
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: { credProps: { rk: true } }, response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })).toString("base64url"),
      attestationObject: Buffer.from(isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array>([["fmt", "none"], ["attStmt", new Map<string, never>()], ["authData", authData]]))).toString("base64url"), transports: ["internal"],
    } };
  }
  assertion(challenge: string, origin = "http://localhost", rpId = "localhost", uv = true): AuthenticationResponseJSON {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([hash(rpId), Buffer.from([uv ? 5 : 1]), counter]);
    const data = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: data.toString("base64url"), authenticatorData: authData.toString("base64url"),
      signature: sign("sha256", Buffer.concat([authData, hash(data)]), this.keys.privateKey).toString("base64url"),
    } };
  }
}
