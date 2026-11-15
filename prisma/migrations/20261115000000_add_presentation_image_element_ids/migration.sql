BEGIN;

ALTER TABLE "PresentationImage" ADD COLUMN "elementId" TEXT;

UPDATE "PresentationImage"
SET "elementId" = "slideId" || ':image';

ALTER TABLE "PresentationImage"
    DROP CONSTRAINT "PresentationImage_pkey",
    ALTER COLUMN "elementId" SET NOT NULL,
    ADD CONSTRAINT "PresentationImage_pkey" PRIMARY KEY ("presentationId", "elementId");

COMMIT;
