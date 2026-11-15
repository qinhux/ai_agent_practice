import { z } from "zod";

export const fileDeliverySchemas = {
  files: z.array(z.strictObject({
    id: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    downloadUrl: z.string().regex(/^\/api\/[a-z-]+\/[a-zA-Z0-9_-]+$/),
    details: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })),
  "file-error": z.string(),
};

export type FileDeliveryData = {
  [Key in keyof typeof fileDeliverySchemas]: z.infer<(typeof fileDeliverySchemas)[Key]>;
};

export const legacyPresentationDownloadSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  slideCount: z.number(),
  fallbackImageCount: z.number(),
  qualityWarning: z.string().optional(),
  qualityWarnings: z.array(z.string()).optional(),
});
