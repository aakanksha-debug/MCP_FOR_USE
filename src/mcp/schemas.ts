import { z } from "zod";
import type { AuditId } from "@/core/types";

export const urlField = z
  .string()
  .min(3)
  .max(2048)
  .describe("Website or page URL, for example https://example.com or example.com/services");

export const connectionIdField = z
  .string()
  .min(10)
  .max(200)
  .describe("Google connection ID returned by google_connect (treat it like a password)");

export const optionalConnectionIdField = connectionIdField
  .optional()
  .describe("Optional Google connection ID from google_connect, to include Search Console data");

export const gscPropertyField = z
  .string()
  .max(300)
  .optional()
  .describe("Search Console property (for example sc-domain:example.com). Auto-detected from the URL when omitted.");

export const auditIdField = z.enum(["seo", "technical", "schema", "aeo", "geo", "conversion", "gbp", "content"] satisfies [AuditId, ...AuditId[]]);

export const issueRefField = z.object({
  code: z.string().min(3).max(100).describe("Issue code from an audit result, for example seo.title.missing"),
  url: z.string().min(3).max(2048).describe("Page URL the issue was reported on"),
});

export const gbpProfileField = z
  .object({
    name: z.string().max(200).optional(),
    primaryCategory: z.string().max(200).optional(),
    secondaryCategories: z.array(z.string().max(200)).max(20).optional(),
    description: z.string().max(2000).optional(),
    hoursSet: z.boolean().optional(),
    phone: z.string().max(50).optional(),
    website: z.string().max(500).optional(),
    address: z.string().max(500).optional(),
    serviceAreaBusiness: z.boolean().optional().describe("True if the business hides its address and serves customers at their location"),
    photoCount: z.number().int().min(0).optional(),
    reviewCount: z.number().int().min(0).optional(),
    averageRating: z.number().min(0).max(5).optional(),
    reviewReplyPercent: z.number().min(0).max(100).optional().describe("Approximate share of reviews with an owner reply"),
    daysSinceLastPost: z.number().int().min(0).optional(),
    servicesListed: z.boolean().optional(),
  })
  .describe("Details the user reads from their Google Business Profile. Only include values the user provided.");
