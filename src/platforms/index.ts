import type { Fetcher } from "@/core/http";
import type { PlatformAdapter, PlatformId } from "./types";
import { WordPressAdapter, type WordPressCredentials } from "./wordpress";

export type PlatformCredentials = WordPressCredentials;

/** Platforms that can publish approved fixes. Add new adapters here. */
export const PUBLISHING_PLATFORMS: Record<PlatformId, string> = {
  wordpress: "WordPress",
};

export function createAdapter(credentials: PlatformCredentials, fetcher?: Fetcher): PlatformAdapter {
  switch (credentials.platform) {
    case "wordpress":
      return new WordPressAdapter(credentials, fetcher);
  }
}

export { PlatformError } from "./types";
export type { ChangeRequest, PlatformAdapter, PlatformId } from "./types";
