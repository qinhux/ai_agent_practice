import { z } from "zod";

export const researchModeSchema = z.enum(["auto", "on", "off"]);
export type ResearchMode = z.infer<typeof researchModeSchema>;
export const sourceUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "来源必须是 HTTP(S) 地址。");

export const researchSourceSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["web", "user"]),
  title: z.string().min(1).max(500),
  url: sourceUrlSchema.optional(),
  publisher: z.string().max(200).optional(),
  publishedAt: z.string().max(100).optional(),
  accessedAt: z.iso.datetime(),
  content: z.string().min(1).max(24000),
});
export const researchEvidenceSchema = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  claim: z.string().min(1).max(400),
  quote: z.string().min(1).max(1200),
  location: z.string().max(160).optional(),
  period: z.string().max(120).optional(),
  scope: z.string().max(200).optional(),
});
export const presentationResearchSchema = z.object({
  mode: researchModeSchema,
  status: z.enum(["skipped", "completed", "unavailable"]),
  sources: z.array(researchSourceSchema).max(12),
  evidence: z.array(researchEvidenceSchema).max(60),
  warnings: z.array(z.string().max(300)).max(16),
});
// A target is a template field name or an added element's UUID, scoped by its stable slideId.
export const slideCitationSchema = z.object({
  target: z.string().min(1).max(64),
  text: z.string().min(1).max(1000),
  evidenceIds: z.array(z.uuid()).min(1).max(3),
  derivation: z.string().max(300).optional(),
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export type PresentationResearch = z.infer<typeof presentationResearchSchema>;
export type SlideCitation = z.infer<typeof slideCitationSchema>;

export class ResearchError extends Error {}

export function normalizedQuote(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export function isEvidenceFromSource(evidence: ResearchEvidence, source: ResearchSource) {
  return evidence.sourceId === source.id && normalizedQuote(source.content).includes(normalizedQuote(evidence.quote));
}
