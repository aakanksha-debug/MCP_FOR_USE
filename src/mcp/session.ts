import type { ServerContext } from "@modelcontextprotocol/server";
import { GoogleIntegrationError } from "@/integrations/google/errors";

/** The Google connection from signing in while adding the connector, if the user chose Google. */
export function sessionGoogleConnection(ctx?: ServerContext): string | undefined {
  const value = ctx?.http?.authInfo?.extra?.googleConnectionId;
  return typeof value === "string" ? value : undefined;
}

/** An explicit connectionId wins; otherwise the signed-in Google account is used. */
export function optionalGoogleConnection(explicit: string | undefined, ctx?: ServerContext): string | undefined {
  return explicit ?? sessionGoogleConnection(ctx);
}

export function requireGoogleConnection(explicit: string | undefined, ctx?: ServerContext): string {
  const connectionId = optionalGoogleConnection(explicit, ctx);
  if (!connectionId) {
    throw new GoogleIntegrationError(
      "Google isn't connected in this session (the connector was added without Google sign-in). Call google_connect to connect Search Console or Analytics with a read-only sign-in link.",
      "not_connected",
    );
  }
  return connectionId;
}
