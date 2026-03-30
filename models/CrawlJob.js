const mongoose = require('mongoose')
const { Schema } = mongoose

const resultSchema = new Schema(
  {
    chapters_found: { type: Number, default: 0 },
    images_uploaded: { type: Number, default: 0 },
    error_message: { type: String, default: '' },
  },
  { _id: false }
)

const crawlJobSchema = new Schema(
  {
    source_id: { type: Schema.Types.ObjectId, ref: 'CrawlSource', required: true },
    comic_id: { type: Schema.Types.ObjectId, ref: 'Comic', required: true },
    type: {
      type: String,
      enum: ['fetch_new_chapters', 'upload_cdn_images'],
      required: true,
    },
    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
    },
    result: { type: resultSchema, default: () => ({}) },
    started_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
  },
  { timestamps: false, versionKey: false }
)

crawlJobSchema.index({ started_at: 1 }, { expireAfterSeconds: 2592000 })

module.exports = mongoose.model('CrawlJob', crawlJobSchema)
