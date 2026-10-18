import { test, expect } from "bun:test";
import { generateRegistrationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { SoftwareAuthenticator } from "./motoko-owner.fixture.ts";

test("Bun verifies ES256 registration and possession without network calls", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; throw new Error("Network forbidden"); }, { preconnect: original.preconnect });
  try {
    const options = await generateRegistrationOptions({ rpName: "Motoko test", rpID: "localhost", userName: "fiction-owner", supportedAlgorithmIDs: [-7], authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    expect(options.pubKeyCredParams.map(p => p.alg)).toEqual([-7]);
    const authenticator = new SoftwareAuthenticator();
    const response = authenticator.registration(options.challenge);
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: options.challenge, expectedOrigin: "http://localhost", expectedRPID: "localhost", requireUserVerification: true, supportedAlgorithmIDs: [-7] });
    expect(verified.verified).toBe(true);
    if (!verified.verified) throw new Error("registration failed");
    const assertion = authenticator.assertion("fiction-proof-challenge");
    const check = (candidate = assertion, publicKey = verified.registrationInfo.credential.publicKey) => verifyAuthenticationResponse({ response: candidate, expectedChallenge: "fiction-proof-challenge", expectedOrigin: "http://localhost", expectedRPID: "localhost", requireUserVerification: true, credential: { ...verified.registrationInfo.credential, publicKey } });
    expect((await check()).verified).toBe(true);
    for (const field of ["clientDataJSON", "authenticatorData", "signature"] as const) {
      const changed = structuredClone(assertion), bytes = Buffer.from(changed.response[field], "base64url"); bytes[0] = bytes[0]! ^ 1; changed.response[field] = bytes.toString("base64url");
      let accepted = false; try { accepted = (await check(changed)).verified; } catch {}
      expect(accepted).toBe(false);
    }
    const publicKey = new Uint8Array(verified.registrationInfo.credential.publicKey); publicKey[publicKey.length - 1] = publicKey[publicKey.length - 1]! ^ 1;
    let accepted = false; try { accepted = (await check(assertion, publicKey)).verified; } catch {}
    expect(accepted).toBe(false);
    const badRegistration = structuredClone(response); const bytes = Buffer.from(badRegistration.response.clientDataJSON, "base64url"); bytes[0] = bytes[0]! ^ 1; badRegistration.response.clientDataJSON = bytes.toString("base64url");
    await expect(verifyRegistrationResponse({ response: badRegistration, expectedChallenge: options.challenge, expectedOrigin: "http://localhost", expectedRPID: "localhost" })).rejects.toThrow();
    expect(calls).toBe(0);
  } finally { globalThis.fetch = original; }
});
