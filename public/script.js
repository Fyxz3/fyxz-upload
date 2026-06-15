const uploadArea = document.getElementById('uploadArea');
const uploadContent = document.getElementById('uploadContent');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const uploadProgress = document.getElementById('uploadProgress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressDetail = document.getElementById('progressDetail');
const result = document.getElementById('result');
const resultUrl = document.getElementById('resultUrl');
const resultDirect = document.getElementById('resultDirect');
const resultInfo = document.getElementById('resultInfo');
const copyBtn = document.getElementById('copyBtn');
const copyDirectBtn = document.getElementById('copyDirectBtn');
const uploadAnother = document.getElementById('uploadAnother');
const recentList = document.getElementById('recentList');

browseBtn.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('click', (e) => {
  if (e.target === uploadArea || e.target === uploadContent || uploadContent.contains(e.target)) {
    fileInput.click();
  }
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length) handleFile(files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file.type.startsWith('video/') && !file.name.match(/\.(mp4|mov|avi|mkv|webm|wmv|flv|m4v|gif)$/i)) {
    alert('Please select a video file');
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    alert('File is too large. Maximum size is 500MB.');
    return;
  }
  uploadContent.style.display = 'none';
  uploadProgress.style.display = 'block';
  result.style.display = 'none';
  uploadFile(file);
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload', true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = pct + '%';
      progressText.textContent = `Uploading... ${pct}%`;
      progressDetail.textContent = formatSize(e.loaded) + ' / ' + formatSize(e.total);
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      if (data.success) {
        progressText.textContent = 'Processing video...';
        progressDetail.textContent = 'Optimizing and generating thumbnail...';
        progressBar.style.width = '100%';
        showResult(data);
      } else {
        showError(data.error || 'Upload failed');
      }
    } else {
      let msg = 'Upload failed';
      try { const d = JSON.parse(xhr.responseText); msg = d.error || msg; } catch(e) {}
      showError(msg);
    }
  };

  xhr.onerror = () => showError('Network error. Please try again.');
  xhr.send(formData);
}

function showResult(data) {
  progressText.textContent = 'Complete!';
  progressDetail.textContent = '';
  result.style.display = 'block';

  resultUrl.value = data.url;
  resultDirect.value = data.direct;

  let info = `${data.filename}`;
  if (data.width && data.height) info += ` &bull; ${data.width}x${data.height}`;
  if (data.fps) info += ` &bull; ${data.fps}fps`;
  if (data.duration) info += ` &bull; ${formatDuration(data.duration)}`;
  info += ` &bull; ${formatSize(data.size)}`;
  resultInfo.textContent = info;

  uploadContent.style.display = 'block';
  uploadProgress.style.display = 'none';

  loadRecent();
}

function showError(msg) {
  progressText.textContent = 'Error';
  progressDetail.textContent = msg;
  progressBar.style.background = '#da3633';
  setTimeout(() => {
    uploadContent.style.display = 'block';
    uploadProgress.style.display = 'none';
    progressBar.style.background = '';
  }, 3000);
}

copyBtn.addEventListener('click', () => copyText(resultUrl.value, copyBtn));
copyDirectBtn.addEventListener('click', () => copyText(resultDirect.value, copyDirectBtn));

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 2000);
  });
}

uploadAnother.addEventListener('click', () => {
  result.style.display = 'none';
  fileInput.value = '';
});

async function loadRecent() {
  try {
    const res = await fetch('/api/videos');
    const videos = await res.json();
    if (!videos.length) {
      recentList.innerHTML = '<div class="recent-empty">No uploads yet</div>';
      return;
    }
    recentList.innerHTML = videos.slice(0, 10).map(v => {
      const meta = [];
      if (v.width && v.height) meta.push(`${v.width}x${v.height}`);
      if (v.fps) meta.push(`${v.fps}fps`);
      if (v.duration) meta.push(formatDuration(v.duration));
      meta.push(formatSize(v.size));
      return `
        <div class="recent-item">
          <div class="recent-item-info">
            <div class="recent-item-name">${escapeHtml(v.original_name)}</div>
            <div class="recent-item-meta">${meta.join(' &bull; ')}</div>
          </div>
          <a href="/v/${v.id}" class="recent-item-link" target="_blank">View &#8599;</a>
        </div>
      `;
    }).join('');
  } catch (e) {}
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

loadRecent();
