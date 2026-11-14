ALTER TABLE "Presentation" ADD COLUMN "source" JSONB;

CREATE TABLE "PresentationImage" (
    "presentationId" TEXT NOT NULL,
    "slideIndex" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "box" JSONB NOT NULL,
    "fallback" BOOLEAN NOT NULL,

    CONSTRAINT "PresentationImage_pkey" PRIMARY KEY ("presentationId", "slideIndex")
);

ALTER TABLE "PresentationImage" ADD CONSTRAINT "PresentationImage_presentationId_fkey" FOREIGN KEY ("presentationId") REFERENCES "Presentation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
