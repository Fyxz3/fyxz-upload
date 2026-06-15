const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const { spawn } = require('child_process');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PROCESSING_LOCKS = new Set();

app.use(session({
  secret: nanoid(40),
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 }
}));

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const HLS_DIR = path.join(__dirname, 'hls');
const THUMBS_DIR = path.join(__dirname, 'thumbnails');
const MAX_SIZE = 500 * 1024 * 1024;

for (const dir of [UPLOADS_DIR, HLS_DIR, THUMBS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${nanoid(16)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|mov|avi|mkv|webm|wmv|flv|m4v|gif)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function getFFprobeData(filePath) {
  return new Promise((resolve, reject) => {
    let probePath = 'ffprobe';
    if (process.platform === 'win32') {
      const possible = [
        'C:\\ffmpeg\\bin\\ffprobe.exe',
        'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe',
        path.join(__dirname, 'ffmpeg', 'ffprobe.exe')
      ];
      for (const p of possible) {
        if (fs.existsSync(p)) { probePath = p; break; }
      }
    }
    const proc = spawn(probePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ]);
    let data = '';
    proc.stdout.on('data', (d) => data += d);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

function getFFmpegPath() {
  if (process.platform !== 'win32') return 'ffmpeg';
  const possible = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(__dirname, 'ffmpeg', 'ffmpeg.exe')
  ];
  for (const p of possible) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

function generateThumbnail(inputPath, outputPath) {
  return new Promise((resolve) => {
    const ffmpeg = getFFmpegPath();
    const proc = spawn(ffmpeg, [
      '-i', inputPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=640:-1',
      '-y', outputPath
    ]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function convertToHLS(inputPath, outputDir, videoId) {
  return new Promise((resolve, reject) => {
    const hlsPath = path.join(outputDir, videoId);
    if (!fs.existsSync(hlsPath)) fs.mkdirSync(hlsPath, { recursive: true });

    const ffmpeg = getFFmpegPath();
    const args = [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(hlsPath, 'seg_%03d.ts'),
      '-progress', '-',
      '-y', path.join(hlsPath, 'playlist.m3u8')
    ];

    const proc = spawn(ffmpeg, args);
    let lastTime = 0;

    proc.stderr.on('data', () => {});
    proc.stdout.on('data', (data) => {
      const out = data.toString();
      const m = out.match(/out_time_us=(\d+)/);
      if (m) lastTime = parseInt(m[1], 10);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('HLS conversion failed'));
    });
    proc.on('error', reject);
  });
}

function evalFps(fpsStr) {
  if (!fpsStr) return null;
  if (!fpsStr.includes('/')) return parseFloat(fpsStr);
  const [n, d] = fpsStr.split('/').map(Number);
  return d ? n / d : null;
}

async function processVideo(videoId, filePath) {
  if (PROCESSING_LOCKS.has(videoId)) return;
  PROCESSING_LOCKS.add(videoId);

  try {
    const probe = await getFFprobeData(filePath);
    const videoStream = probe.streams?.find(s => s.codec_type === 'video');
    let width = null, height = null, fps = null, duration = null;
    let needsProcessing = false;

    if (videoStream) {
      width = videoStream.width || null;
      height = videoStream.height || null;
      fps = evalFps(videoStream.r_frame_rate || videoStream.avg_frame_rate);
      duration = parseFloat(probe.format?.duration || videoStream.duration || 0);

      if ((width > 1920 || height > 1080) || fps > 60) needsProcessing = true;
    }

    let finalPath = filePath;

    if (needsProcessing) {
      let newPath = path.join(UPLOADS_DIR, `${nanoid(16)}.mp4`);
      const ffmpeg = getFFmpegPath();
      const args = ['-i', filePath];
      if (width > 1920 || height > 1080)
        args.push('-vf', 'scale=\'min(1920,iw)\':\'min(1080,ih)\':force_original_aspect_ratio=decrease');
      if (fps > 60) args.push('-r', '60');
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
      args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart', '-y', newPath);

      await new Promise((resolve, reject) => {
        const proc = spawn(ffmpeg, args);
        proc.on('close', (code) => code === 0 ? resolve() : reject());
        proc.on('error', reject);
      });

      fs.unlinkSync(filePath);
      finalPath = newPath;

      const probe2 = await getFFprobeData(finalPath);
      const vs = probe2.streams?.find(s => s.codec_type === 'video');
      if (vs) {
        width = vs.width || null;
        height = vs.height || null;
        fps = evalFps(vs.r_frame_rate || vs.avg_frame_rate);
        duration = parseFloat(probe2.format?.duration || vs.duration || 0);
      }
    }

    const thumbnailName = `${nanoid(12)}.jpg`;
    const ok = await generateThumbnail(finalPath, path.join(THUMBS_DIR, thumbnailName));
    const stat = fs.statSync(finalPath);

    db.updateVideo(videoId, {
      filename: path.basename(finalPath),
      width, height,
      fps: fps ? Math.round(fps) : null,
      duration: duration ? Math.round(duration * 100) / 100 : null,
      size: stat.size,
      thumbnail: ok ? thumbnailName : null
    });

    convertToHLS(finalPath, HLS_DIR, videoId).then(() => {
      db.setHlsReady(videoId, true);
    }).catch(() => {});
  } catch (e) {
    console.error(`Processing error for ${videoId}:`, e.message);
  } finally {
    PROCESSING_LOCKS.delete(videoId);
  }
}

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) {
      fs.unlinkSync(filePath);
      return res.status(413).json({ error: 'File too large' });
    }

    const id = nanoid(11);
    const isGif = path.extname(req.file.originalname).toLowerCase() === '.gif';
    const sessionId = req.session.id;

    db.insertVideo({
      id,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: isGif ? 'image/gif' : 'video/mp4',
      size: stat.size,
      width: null, height: null, fps: null, duration: null,
      thumbnail: null,
      sessionId
    });

    if (!isGif) {
      processVideo(id, filePath);
    }

    const baseUrl = getBaseUrl(req);
    res.json({
      success: true,
      id,
      url: `${baseUrl}/v/${id}`,
      direct: `${baseUrl}/raw/${id}`,
      filename: req.file.filename,
      size: stat.size
    });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.get('/v/:id', (req, res) => {
  const video = db.getVideo(req.params.id);
  if (!video) return res.status(404).render('player', { video: null, error: 'Video not found', baseUrl: getBaseUrl(req), hlsReady: false, directUrl: '', thumbUrl: '' });

  const baseUrl = getBaseUrl(req);
  const directUrl = `${baseUrl}/raw/${video.id}`;
  const thumbUrl = video.thumbnail ? `${baseUrl}/thumb/${video.thumbnail}` : null;
  const hlsReady = video.hls_ready === 1;

  res.render('player', {
    video, directUrl, thumbUrl, baseUrl,
    hlsUrl: `${baseUrl}/hls/${video.id}/playlist.m3u8`,
    hlsReady,
    error: null
  });
});

app.get('/raw/:id', (req, res) => {
  const video = db.getVideo(req.params.id);
  if (!video) return res.status(404).send('Video not found');

  const filePath = path.join(UPLOADS_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': video.mime_type || 'video/mp4',
      'Cache-Control': 'public, max-age=31536000'
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': video.mime_type || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/hls/:id/:file', (req, res) => {
  const filePath = path.join(HLS_DIR, req.params.id, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  if (req.params.file.endsWith('.m3u8')) {
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
  } else if (req.params.file.endsWith('.ts')) {
    res.set('Content-Type', 'video/mp2t');
  }
  res.set('Cache-Control', 'public, max-age=31536000');
  res.sendFile(filePath);
});

app.get('/thumb/:name', (req, res) => {
  const thumbPath = path.join(THUMBS_DIR, req.params.name);
  if (!fs.existsSync(thumbPath)) return res.status(404).send('Not found');
  res.sendFile(thumbPath);
});

app.get('/api/video/:id', (req, res) => {
  const video = db.getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const baseUrl = getBaseUrl(req);
  res.json({
    ...video,
    url: `${baseUrl}/v/${video.id}`,
    direct: `${baseUrl}/raw/${video.id}`,
    thumbnail: video.thumbnail ? `${baseUrl}/thumb/${video.thumbnail}` : null
  });
});

app.get('/api/videos', (req, res) => {
  const sessionId = req.session.id;
  res.json(db.getVideosBySession(sessionId));
});

app.delete('/api/video/:id', (req, res) => {
  const video = db.getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(UPLOADS_DIR, video.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const hlsDir = path.join(HLS_DIR, req.params.id);
  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });

  if (video.thumbnail) {
    const tp = path.join(THUMBS_DIR, video.thumbnail);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
  }
  db.deleteVideo(req.params.id);
  res.json({ success: true });
});

app.get('/oembed', (req, res) => {
  const video = db.getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const baseUrl = getBaseUrl(req);
  res.json({
    type: 'video',
    version: '1.0',
    title: video.original_name,
    author_name: 'Fyxz Upload',
    provider_name: 'Fyxz Upload',
    provider_url: baseUrl,
    url: `${baseUrl}/v/${video.id}`,
    html: `<video controls width="${Math.min(video.width || 1280, 1280)}" height="${Math.min(video.height || 720, 720)}" poster="${video.thumbnail ? `${baseUrl}/thumb/${video.thumbnail}` : ''}"><source src="${baseUrl}/raw/${video.id}" type="${video.mime_type || 'video/mp4'}"></video>`,
    width: Math.min(video.width || 1280, 1280),
    height: Math.min(video.height || 720, 720)
  });
});

app.listen(PORT, () => {
  console.log(`Fyxz Upload running on port ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err);
});
