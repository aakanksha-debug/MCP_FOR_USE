/** Errors with a message that is safe and useful to show the user. */
export class GoogleIntegrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "storage_unavailable"
      | "not_connected"
      | "expired"
      | "access_denied"
      | "not_found"
      | "api_error" = "api_error",
  ) {
    super(message);
    this.name = "GoogleIntegrationError";
  }
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string } | string;
  error_description?: string;
}

/** Calls a Google API with a bearer token and maps errors to friendly messages. */
export async function googleFetch<T>(url: string, accessToken: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  if (response.ok) return (await response.json()) as T;

  let message = `Google API returned HTTP ${response.status}`;
  try {
    const body = (await response.json()) as GoogleErrorBody;
    const detail = typeof body.error === "string" ? body.error_description ?? body.error : body.error?.message;
    if (detail) message = detail;
  } catch {
    // Keep the generic message.
  }
  if (response.status === 401) throw new GoogleIntegrationError("Google access has expired or was revoked. Please reconnect Google.", "expired");
  if (response.status === 403) {
    throw new GoogleIntegrationError(
      `Google denied access: ${message}. Make sure the signed-in Google account has access to this property.`,
      "access_denied",
    );
  }
  if (response.status === 404) throw new GoogleIntegrationError(`Not found: ${message}`, "not_found");
  throw new GoogleIntegrationError(message, "api_error");
}
