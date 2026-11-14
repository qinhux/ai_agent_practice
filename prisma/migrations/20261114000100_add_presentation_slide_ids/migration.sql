BEGIN;

UPDATE "Presentation"
SET "source" = jsonb_set("source", '{slides}', (
    SELECT COALESCE(
        jsonb_agg(slide || jsonb_build_object('slideId', gen_random_uuid()) ORDER BY position),
        '[]'::jsonb
    )
    FROM jsonb_array_elements("source"->'slides') WITH ORDINALITY AS pages(slide, position)
))
WHERE jsonb_typeof("source"->'slides') = 'array';

ALTER TABLE "PresentationImage" ADD COLUMN "slideId" TEXT;

UPDATE "PresentationImage" AS image
SET "slideId" = presentation."source"->'slides'->(image."slideIndex")->>'slideId'
FROM "Presentation" AS presentation
WHERE presentation."id" = image."presentationId";

ALTER TABLE "PresentationImage"
    DROP CONSTRAINT "PresentationImage_pkey",
    ALTER COLUMN "slideId" SET NOT NULL,
    DROP COLUMN "slideIndex",
    ADD CONSTRAINT "PresentationImage_pkey" PRIMARY KEY ("presentationId", "slideId");

COMMIT;
