const mongoose = require('mongoose')
const { Schema } = mongoose

const pageSchema = new Schema(
  {
    page_number: { type: Number, required: true },
    scraped_url: { type: String, default: '' },
    cdn_url: { type: String, default: '' },
  },
  { _id: false }
)

const cdnStatusSchema = new Schema(
  {
    is_uploaded: { type: Boolean, default: false },
    uploaded_at: { type: Date },
  },
  { _id: false }
)

const chapterSchema = new Schema(
  {
    comic_id: { type: Schema.Types.ObjectId, ref: 'Comic', required: true },
    comic_slug: { type: String, required: true, trim: true },
    chapter_number: { type: Number, required: true },
    title: { type: String, default: '', trim: true },
    slug: { type: String, required: true, trim: true },
    image_source: {
      type: String,
      enum: ['scraped', 'cdn'],
      default: 'scraped',
    },
    pages: { type: [pageSchema], default: [] },
    cdn_status: { type: cdnStatusSchema, default: () => ({}) },
    views: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
)

// Không cho insert trùng chapter cùng comic
chapterSchema.index({ comic_id: 1, chapter_number: 1 }, { unique: true })

module.exports = mongoose.model('Chapter', chapterSchema)
