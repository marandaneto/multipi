import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError, email, type Identity } from "../shared/protocol";

export type AuthConfig = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  APP_ORIGIN?: string;
  LOCAL_DEV?: string;
};
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccess(
  token: string,
  config: AuthConfig,
  key?: JWTVerifyGetKey,
): Promise<Identity> {
  const domain = config.ACCESS_TEAM_DOMAIN;
  if (
    !domain ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) ||
    !config.ACCESS_AUDIENCE
  ) {
    throw new AppError(503, "Access authentication is not configured");
  }
  const issuer = `https://${domain}`;
  let resolved = key;
  if (!resolved) {
    if (!keys.has(issuer))
      keys.set(
        issuer,
        createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      );
    resolved = keys.get(issuer)!;
  }
  try {
    const { payload } = await jwtVerify(token, resolved, {
      issuer,
      audience: config.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "email"],
    });
    return {
      id: email.parse(payload.email),
      subject: String(payload.sub),
      expiresAt: Number(payload.exp) * 1000,
    };
  } catch {
    throw new AppError(401, "Invalid or expired Access identity");
  }
}

export async function authenticate(
  request: Request,
  config: AuthConfig,
): Promise<Identity> {
  const url = new URL(request.url);
  if (
    config.LOCAL_DEV === "true" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    const id = email.parse(
      request.headers.get("x-multipi-dev-user") ?? "developer@example.test",
    );
    return { id, subject: `local:${id}`, expiresAt: Date.now() + 3_600_000 };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AppError(401, "Sign in through Cloudflare Access");
  return verifyAccess(token, config);
}

export function requireSameOrigin(request: Request, config: AuthConfig) {
  const expected =
    config.APP_ORIGIN ??
    (config.LOCAL_DEV === "true" ? new URL(request.url).origin : undefined);
  if (!expected || request.headers.get("Origin") !== expected)
    throw new AppError(403, "Origin not allowed");
}

export function allowedRepository(
  repo: string,
  principal: string,
  policy: string | undefined,
) {
  let rules: Record<string, string[]> = {};
  try {
    rules = JSON.parse(policy ?? "{}");
  } catch {
    throw new AppError(503, "Invalid repository policy");
  }
  const allowed = rules[repo];
  if (!Array.isArray(allowed) || !allowed.includes(principal))
    throw new AppError(403, "Repository access not granted");
}
