-- CreateEnum
CREATE TYPE "ComicType" AS ENUM ('manhwa', 'manga', 'manhua', 'comic');

-- CreateEnum
CREATE TYPE "ComicStatus" AS ENUM ('ongoing', 'completed', 'hiatus', 'dropped');

-- CreateEnum
CREATE TYPE "ContentRating" AS ENUM ('safe', 'suggestive', 'explicit');

-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('scraped', 'cdn');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('fetch_new_chapters', 'upload_cdn_images');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "comics" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alt_titles" TEXT[],
    "type" "ComicType" NOT NULL,
    "status" "ComicStatus" NOT NULL DEFAULT 'ongoing',
    "description" TEXT,
    "authors" TEXT[],
    "artists" TEXT[],
    "content_rating" "ContentRating" NOT NULL DEFAULT 'safe',
    "cover" JSONB DEFAULT '{"scraped_url": "", "cdn_url": "", "active_source": "scraped"}',
    "stats" JSONB DEFAULT '{"views_total": 0, "views_monthly": 0, "views_weekly": 0, "views_daily": 0, "rating_avg": 0, "rating_count": 0, "total_chapters": 0, "bookmarks_count": 0}',
    "latest_chapters" JSONB DEFAULT '[]',
    "crawl_source_id" INTEGER,
    "crawl_source_url" TEXT,
    "last_crawled_at" TIMESTAMP(3),
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" SERIAL NOT NULL,
    "comic_id" INTEGER NOT NULL,
    "comic_slug" TEXT NOT NULL,
    "chapter_number" DOUBLE PRECISION NOT NULL,
    "title" TEXT,
    "slug" TEXT NOT NULL,
    "image_source" "ImageSource" NOT NULL DEFAULT 'scraped',
    "pages" JSONB DEFAULT '[]',
    "cdn_status" JSONB DEFAULT '{"is_uploaded": false, "uploaded_at": null}',
    "views" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_sources" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "selectors" JSONB DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "analyzed_at" TIMESTAMP(3),

    CONSTRAINT "crawl_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_jobs" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "comic_id" INTEGER NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'running',
    "result" JSONB DEFAULT '{"chapters_found": 0, "images_uploaded": 0, "error_message": ""}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "genres" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "comic_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "genres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ComicGenres" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ComicGenres_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "comics_slug_key" ON "comics"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_comic_id_chapter_number_key" ON "chapters"("comic_id", "chapter_number");

-- CreateIndex
CREATE UNIQUE INDEX "genres_slug_key" ON "genres"("slug");

-- CreateIndex
CREATE INDEX "_ComicGenres_B_index" ON "_ComicGenres"("B");

-- AddForeignKey
ALTER TABLE "comics" ADD CONSTRAINT "comics_crawl_source_id_fkey" FOREIGN KEY ("crawl_source_id") REFERENCES "crawl_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_comic_id_fkey" FOREIGN KEY ("comic_id") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "crawl_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_comic_id_fkey" FOREIGN KEY ("comic_id") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ComicGenres" ADD CONSTRAINT "_ComicGenres_A_fkey" FOREIGN KEY ("A") REFERENCES "comics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ComicGenres" ADD CONSTRAINT "_ComicGenres_B_fkey" FOREIGN KEY ("B") REFERENCES "genres"("id") ON DELETE CASCADE ON UPDATE CASCADE;
