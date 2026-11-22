import { DraftStore } from "./draft-store";
import { loadPresentationForEdit, preparePresentationDrafts, type PresentationDraft } from "./save-presentation";
import type { PresentationImage, PresentationSource } from "./presentations";
import { removeStaleCitations, validatePresentationCitations } from "./presentation-research";
import { ResearchError } from "./research-schema";
import type { PresentationModelOptions } from "./presentation-json";

export class PresentationDrafts {
  private readonly drafts: DraftStore<PresentationDraft>;

  constructor(private readonly userId: string) {
    this.drafts = new DraftStore<PresentationDraft>(async (presentationId) => {
      const original = await loadPresentationForEdit(userId, presentationId);
      if ("error" in original) return original;
      return { ...original, parentId: presentationId, warnings: [] };
    });
  }

  get hasChanges() {
    return this.drafts.hasChanges;
  }

  get(presentationId: string) {
    return this.drafts.get(presentationId);
  }

  create(source: PresentationSource, images: PresentationDraft["images"]) {
    return this.drafts.create({ source, images, warnings: [] });
  }

  edit<T extends object>(
    presentationId: string,
    abortSignal: AbortSignal | undefined,
    apply: (draft: {
      source: PresentationSource;
      images: Map<string, PresentationImage>;
      stage: (source: PresentationSource, warnings?: string[]) => void;
    }) => Promise<T>,
  ) {
    return this.drafts.edit(presentationId, abortSignal, async (draft, stage) => {
      const images = new Map(draft.images);
      let staged: PresentationDraft | undefined;
      const result = await apply({
        source: draft.source,
        images,
        stage: (source, warnings = []) => {
          staged = {
            source, images,
            parentId: draft.parentId,
            warnings: [...new Set([...draft.warnings, ...warnings])],
          };
        },
      });
      if (staged && !("error" in result)) {
        const next = removeStaleCitations(staged.source);
        validatePresentationCitations(next);
        stage({ ...staged, source: next });
      }
      return result;
    }).catch((error: unknown) => {
      if (error instanceof ResearchError) return { error: error.message };
      throw error;
    });
  }

  prepareSave(abortSignal: AbortSignal, model?: PresentationModelOptions) {
    return preparePresentationDrafts(this.userId, this.drafts.values(), abortSignal, model);
  }
}
