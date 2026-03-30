const mongoose = require('mongoose')

const genreSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    comic_count: { type: Number, default: 0 },
  },
  { timestamps: false, versionKey: false }
)

module.exports = mongoose.model('Genre', genreSchema)
