import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { authenticate, verifyAccess } from "../../src/worker/auth";

describe("Access JWT verification", () => {
  it("checks signature, issuer, audience and expiration", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const key = await exportJWK(pair.publicKey);
    const jwks = createLocalJWKSet({
      keys: [{ ...key, kid: "test", alg: "RS256" }],
    });
    const token = (aud: string, exp: number) =>
      new SignJWT({ email: "Alice@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setSubject("alice")
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(pair.privateKey);
    const config = {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUDIENCE: "multipi",
    };
    expect(
      (
        await verifyAccess(
          await token("multipi", Math.floor(Date.now() / 1000) + 60),
          config,
          jwks,
        )
      ).id,
    ).toBe("alice@example.test");
    await expect(
      verifyAccess(
        await token("other", Math.floor(Date.now() / 1000) + 60),
        config,
        jwks,
      ),
    ).rejects.toThrow();
    await expect(
      verifyAccess(await token("multipi", 1), config, jwks),
    ).rejects.toThrow();
  });
  it("never accepts a dev identity on a public hostname", async () => {
    await expect(
      authenticate(
        new Request("https://multipi.test/", {
          headers: { "x-multipi-dev-user": "owner@example.test" },
        }),
        { LOCAL_DEV: "true" },
      ),
    ).rejects.toThrow();
  });
});
