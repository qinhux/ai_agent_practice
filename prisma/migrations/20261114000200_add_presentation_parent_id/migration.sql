ALTER TABLE "Presentation" ADD COLUMN "parentId" TEXT;

CREATE INDEX "Presentation_parentId_idx" ON "Presentation"("parentId");

ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Presentation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
