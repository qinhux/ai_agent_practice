import { randomUUID } from "node:crypto";

type DraftError = { error: string };

export class DraftStore<Draft extends object> {
  private readonly drafts = new Map<string, Draft>();
  private readonly editing = new Set<string>();

  constructor(private readonly load: (fileId: string) => Promise<Draft | DraftError>) {}

  get hasChanges() {
    return this.drafts.size > 0;
  }

  get(fileId: string) {
    return this.drafts.get(fileId);
  }

  create(draft: Draft) {
    const fileId = randomUUID();
    this.drafts.set(fileId, draft);
    return fileId;
  }

  values() {
    return this.drafts.values();
  }

  async edit<Result extends object>(
    fileId: string,
    abortSignal: AbortSignal | undefined,
    apply: (current: Readonly<Draft>, stage: (draft: Draft) => void) => Promise<Result>,
  ): Promise<Result | DraftError> {
    abortSignal?.throwIfAborted();
    if (this.editing.has(fileId)) return { error: "同一份文件的修改需要顺序执行。" };
    this.editing.add(fileId);
    try {
      const current = this.drafts.get(fileId) ?? await this.load(fileId);
      abortSignal?.throwIfAborted();
      if ("error" in current) return current;

      let staged: Draft | undefined;
      const result = await apply(current, (draft) => { staged = draft; });
      abortSignal?.throwIfAborted();
      if (staged && !("error" in result)) this.drafts.set(fileId, staged);
      return result;
    } finally {
      this.editing.delete(fileId);
    }
  }
}
