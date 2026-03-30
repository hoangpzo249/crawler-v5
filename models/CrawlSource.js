const mongoose = require('mongoose')
const { Schema } = mongoose

const crawlSourceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    base_url: { type: String, required: true, trim: true },
    selectors: { type: Schema.Types.Mixed, default: () => ({}) },
    is_active: { type: Boolean, default: true },
    analyzed_at: { type: Date, default: null },
  },
  { timestamps: false, versionKey: false }
)

module.exports = mongoose.model('CrawlSource', crawlSourceSchema)
