const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.db');
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, '');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    fps INTEGER,
    duration REAL,
    thumbnail TEXT,
    hls_ready INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Add hls_ready column if it doesn't exist (for existing DBs)
try {
  db.exec('ALTER TABLE videos ADD COLUMN hls_ready INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  // Column already exists, ignore
}

function insertVideo({ id, filename, originalName, mimeType, size, width, height, fps, duration, thumbnail }) {
  const stmt = db.prepare(`
    INSERT INTO videos (id, filename, original_name, mime_type, size, width, height, fps, duration, thumbnail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, filename, originalName, mimeType, size, width, height, fps, duration, thumbnail);
}

function getVideo(id) {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
}

function getAllVideos() {
  return db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all();
}

function deleteVideo(id) {
  return db.prepare('DELETE FROM videos WHERE id = ?').run(id);
}

function setHlsReady(id, ready) {
  return db.prepare('UPDATE videos SET hls_ready = ? WHERE id = ?').run(ready ? 1 : 0, id);
}

function updateVideo(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

module.exports = { insertVideo, getVideo, getAllVideos, deleteVideo, setHlsReady, updateVideo };
