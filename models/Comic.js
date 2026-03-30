const mongoose = require('mongoose')
const { Schema } = mongoose

const latestChapterSchema = new Schema(
  {
    chapter_id: { type: Schema.Types.ObjectId, ref: 'Chapter', required: true },
    chapter_number: { type: Number, required: true },
    slug: { type: String, required: true },
    created_at: { type: Date, required: true },
  },
  { _id: false }
)

const coverSchema = new Schema(
  {
    scraped_url: { type: String, default: '' },
    cdn_url: { type: String, default: '' },
    active_source: {
      type: String,
      enum: ['scraped', 'cdn'],
      default: 'scraped',
    },
  },
  { _id: false }
)

const statsSchema = new Schema(
  {
    views_total: { type: Number, default: 0 },
    views_monthly: { type: Number, default: 0 },
    views_weekly: { type: Number, default: 0 },
    views_daily: { type: Number, default: 0 },
    rating_avg: { type: Number, default: 0, min: 0, max: 5 },
    rating_count: { type: Number, default: 0 },
    total_chapters: { type: Number, default: 0 },
    bookmarks_count: { type: Number, default: 0 },
  },
  { _id: false }
)

const crawlInfoSchema = new Schema(
  {
    source_id: { type: Schema.Types.ObjectId, ref: 'CrawlSource' },
    source_url: { type: String, default: '' },
    last_crawled_at: { type: Date },
  },
  { _id: false }
)

const comicSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    alt_titles: { type: [String], default: [] },
    type: {
      type: String,
      enum: ['manhwa', 'manga', 'manhua', 'comic'],
      required: true,
    },
    status: {
      type: String,
      enum: ['ongoing', 'completed', 'hiatus', 'dropped'],
      default: 'ongoing',
    },
    description: { type: String, default: '' },
    authors: { type: [String], default: [] },
    artists: { type: [String], default: [] },
    genres: { type: [String], default: [] },
    content_rating: {
      type: String,
      enum: ['safe', 'suggestive', 'explicit'],
      default: 'safe',
    },
    cover: { type: coverSchema, default: () => ({}) },
    stats: { type: statsSchema, default: () => ({}) },
    latest_chapters: {
      type: [latestChapterSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= 3,
        message: 'latest_chapters cannot exceed 3 items',
      },
    },
    crawl_info: { type: crawlInfoSchema, default: () => ({}) },
    is_hidden: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
)

module.exports = mongoose.model('Comic', comicSchema)
