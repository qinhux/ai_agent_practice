import type { Prisma } from "@/generated/prisma/client";
import type { FileDeliveryData } from "@/lib/file-delivery";
import { getPrisma } from "./db";
import { PresentationDrafts } from "./presentation-drafts";

type SaveDrafts = (transaction: Prisma.TransactionClient) => Promise<FileDeliveryData["files"]>;

type DraftManager = {
  readonly hasChanges: boolean;
  prepareSave: (signal: AbortSignal) => Promise<SaveDrafts>;
};

function createDraftManagers(userId: string) {
  return {
    presentation: new PresentationDrafts(userId),
  } satisfies Record<string, DraftManager>;
}

export class FileDrafts {
  private readonly managers: ReturnType<typeof createDraftManagers>;

  constructor(userId: string) {
    this.managers = createDraftManagers(userId);
  }

  get<Kind extends keyof typeof this.managers>(kind: Kind) {
    return this.managers[kind];
  }

  get hasChanges() {
    return Object.values(this.managers).some((manager) => manager.hasChanges);
  }

  async save(signal: AbortSignal): Promise<FileDeliveryData["files"]> {
    const prepared: SaveDrafts[] = [];
    for (const manager of Object.values(this.managers)) {
      if (manager.hasChanges) {
        signal.throwIfAborted();
        prepared.push(await manager.prepareSave(signal));
      }
    }
    if (!prepared.length) return [];
    signal.throwIfAborted();
    return getPrisma().$transaction(async (transaction) => {
      const files: FileDeliveryData["files"] = [];
      for (const save of prepared) {
        signal.throwIfAborted();
        files.push(...await save(transaction));
      }
      signal.throwIfAborted();
      return files;
    });
  }
}
