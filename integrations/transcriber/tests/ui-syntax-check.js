
let videos = [];
let pollTimer = null;
let isTranscribing = false;

function $(id) { return document.getElementById(id); }

// ── Open folder in Explorer ──
async function openFolder(inputId) {
  const path = $(inputId).value.trim();
  if (!path) return;
  await fetch(`/api/open_folder?path=${encodeURIComponent(path)}`);
}

async function openOutputFolder(videoPath) {
  await fetch(`/api/open_output_folder?path=${encodeURIComponent(videoPath)}`);
}

// ── Folder Picker ──
async function pickFolder(inputId) {
  const initDir = $(inputId).value || '';
  const res = await fetch(`/api/pick_folder?init=${encodeURIComponent(initDir)}`);
  const data = await res.json();
  if (data.path) {
    $(inputId).value = data.path;
    if (inputId === 'videoDir') {
      $('outputDir').value = data.path;
    }
  }
}

// ── Scan ──
async function scanVideos() {
  const videoDir = $('videoDir').value.trim();
  if (!videoDir) { alert('请输入视频目录'); return; }
  const res = await fetch('/api/scan', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ video_dir: videoDir })
  });
  const data = await res.json();
  videos = data.videos || [];
  renderVideoList();
}

function renderVideoList() {
  if (videos.length === 0) {
    $('listCard').style.display = 'none';
    alert('未找到音视频文件，请检查目录');
    return;
  }
  $('listCard').style.display = 'block';

  const doneCount = videos.filter(v => v.has_txt).length;
  const list = $('videoList');
  list.innerHTML = videos.map((v, i) => `
    <div class="video-item">
      <input type="checkbox" class="vcheck" data-idx="${i}" ${v.has_txt ? '' : 'checked'}>
      <span class="video-name" title="${v.path}">${v.name}</span>
      <span class="video-ext">${v.ext}</span>
      <button class="btn btn-sm" style="padding:2px 6px;font-size:12px" onclick="openOutputFolder(videos[${i}].path)" title="打开字幕文件夹">📂</button>
      <span class="video-size">${v.size_mb}MB</span>
      <span class="badge ${v.has_txt ? 'badge-done' : 'badge-pending'}">${v.has_txt ? '已有' : '未生成'}</span>
    </div>
  `).join('');

  updateSelectCount();

  // Listen for checkbox changes
  list.querySelectorAll('.vcheck').forEach(cb => {
    cb.addEventListener('change', updateSelectCount);
  });
}

function getSelected() {
  const checks = document.querySelectorAll('.vcheck:checked');
  return Array.from(checks).map(cb => videos[parseInt(cb.dataset.idx)]);
}

function toggleAll(checked) {
  document.querySelectorAll('.vcheck').forEach(cb => cb.checked = checked);
  updateSelectCount();
}

function toggleMediaType(type) {
  document.querySelectorAll('.vcheck').forEach(cb => {
    cb.checked = videos[parseInt(cb.dataset.idx)].media_type === type;
  });
  updateSelectCount();
}

function togglePending() {
  document.querySelectorAll('.vcheck').forEach((cb, i) => {
    cb.checked = !videos[i].has_txt;
  });
  updateSelectCount();
}

function updateSelectCount() {
  const sel = getSelected().length;
  const done = getSelected().filter(v => v.has_txt).length;
  let text = `已选 ${sel} / ${videos.length}`;
  if (done > 0) text += `（${done} 个已有逐字稿）`;
  $('selectCount').textContent = text;
}

// ── Transcribe ──
async function startTranscribe() {
  const selected = getSelected();
  if (selected.length === 0) { alert('请选择视频'); return; }

  const overwrite = $('overwrite').checked;
  const existing = selected.filter(v => v.has_txt);

  if (existing.length > 0 && !overwrite) {
    const names = existing.map(v => v.name).join('\n');
    const proceed = await showConfirm(
      '以下视频已有逐字稿',
      `共 ${existing.length} 个：\n${names}\n\n要覆盖它们吗？取消则自动跳过。`
    );
    if (proceed) {
      $('overwrite').checked = true;
    }
  }

  const res = await fetch('/api/transcribe', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      videos: getSelected(),
      video_dir: $('videoDir').value.trim(),
      output_dir: $('outputDir').value.trim(),
      overwrite: $('overwrite').checked,
      transcribe_mode: 'stable',
      add_ipa: $('addIpa').checked,
      language: $('languageSelect').value,
    })
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  isTranscribing = true;
  $('progressCard').style.display = 'block';
  $('btnGenerate').disabled = true;
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 1000);
}

async function pollStatus() {
  const res = await fetch('/api/status');
  const s = await res.json();

  $('progressBar').style.width = s.progress + '%';
  $('progressPercent').textContent = s.progress + '%';
  $('progressLabel').textContent = `${s.current_index} / ${s.total}`;
  const chunkText = s.chunk_seconds ? `每段 ${Math.round(s.chunk_seconds / 60)} 分钟 · ${s.chunk_policy || ''}` : '';
  const modeText = s.transcribe_mode_label ? `模式: ${s.transcribe_mode_label}` : '';
  const ipaText = s.add_ipa ? '英文音标: 开' : '';
  const chunkModeText = s.chunk_mode === 'manual' ? '手动切片' : '';
  $('progressEta').textContent = [s.eta ? `预计剩余: ${s.eta}` : '', modeText, ipaText, chunkModeText, chunkText].filter(Boolean).join(' | ');

  if (s.transcribing && s.cancel_requested) {
    $('progressCurrent').textContent = '正在取消，等待当前分块结束...';
  } else if (s.current_video) {
    const name = s.current_video.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
    if (s.phase === 'extracting') {
      $('progressCurrent').innerHTML = `<span class="spinner"></span> 正在提取音频: ${name}`;
    } else {
      let chunkInfo = '';
      if (s.chunk_total > 0) {
        chunkInfo = ` (段 ${s.chunk_current}/${s.chunk_total})`;
      } else {
        chunkInfo = ' (模型推理中...)';
      }
      $('progressCurrent').innerHTML = `<span class="spinner"></span> 正在转写: ${name}${chunkInfo}`;
    }
  }

  if (!s.transcribing) {
    clearInterval(pollTimer);
    isTranscribing = false;
    if (s.cancel_requested) {
      $('progressCurrent').textContent = '已取消，已完成的分块已保存';
    } else {
      $('progressCurrent').textContent = '✅ 全部完成';
      $('progressBar').style.width = '100%';
      $('progressPercent').textContent = '100%';
    }
    $('btnGenerate').disabled = false;
    showResults(s);
    // Refresh list
    scanVideos();
  }
}

async function cancelTranscribe() {
  const res = await fetch('/api/cancel', { method: 'POST' });
  const data = await res.json();
  if (data.status === 'cancelling') {
    $('progressCurrent').textContent = '正在取消，等待当前分块结束...';
  }
  await pollStatus();
}

function showResults(s) {
  $('resultCard').style.display = 'block';
  let html = '';
  s.done.forEach(d => {
    const name = d.name || d.video;
    html += `<div class="video-item">
      <span class="video-name">${name}</span>
      <span class="badge badge-done">✅ ${d.elapsed}s</span>
      <button class="btn btn-sm" onclick="viewTranscript(this)" data-path="${encodeURIComponent(d.video)}">查看</button>
    </div>`;
  });
  s.errors.forEach(e => {
    const name = e.name || e.video;
    html += `<div class="video-item">
      <span class="video-name">${name}</span>
      <span class="badge" style="background:var(--red-light);color:var(--red)">❌ ${e.error}</span>
    </div>`;
  });
  $('resultList').innerHTML = html;
}

// ── Transcript viewer ──
async function viewTranscript(btn) {
  const path = decodeURIComponent(btn.dataset.path);
  const res = await fetch(`/api/transcript?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  $('transcriptCard').style.display = 'block';
  const name = path.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
  $('transcriptTitle').textContent = name;
  $('transcriptContent').textContent = data.text || '(无内容)';
  $('transcriptCard').scrollIntoView({ behavior: 'smooth' });
}

function closeTranscript() {
  $('transcriptCard').style.display = 'none';
}

// ── Modal ──
function showConfirm(title, msg) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = msg;
    $('confirmModal').classList.add('active');
    $('confirmOk').onclick = () => { closeModal(); resolve(true); };
    $('confirmModal').onclick = (e) => { if (e.target === $('confirmModal')) { closeModal(); resolve(false); } };
  });
}
function closeModal() { $('confirmModal').classList.remove('active'); }

// ── Browser close protection ──
window.addEventListener('beforeunload', (e) => {
  if (isTranscribing) {
    e.preventDefault();
    e.returnValue = '视频正在转写中，关闭将中断任务。确定要关闭吗？';
  }
});

// ── Auto scan on load ──
function trackRunningTask(info) {
  $('videoDir').value = info.video_dir;
  $('outputDir').value = info.output_dir || info.video_dir;
  $('languageSelect').value = info.language || 'auto';
  isTranscribing = true;
  $('progressCard').style.display = 'block';
  $('btnGenerate').disabled = true;
  startPolling();
  pollStatus();
}

window.addEventListener('load', async () => {
  checkGPU();
  // Check for resumable state
  try {
    const res = await fetch('/api/resume_check');
    const data = await res.json();
    if (data.running) {
      trackRunningTask(data);
      return;
    }
    if (data.remaining > 0) {
      const ok = await showConfirm(
        '检测到未完成的任务',
        `上次有 ${data.remaining} 个视频未完成转写。\n\n选择"确定"继续，选择"取消"放弃。`
      );
      if (ok) {
        const r2 = await fetch('/api/resume', { method: 'POST' });
        const d2 = await r2.json();
        if (d2.status === 'resumed' || d2.status === 'running') {
          trackRunningTask(d2);
          return;
        }
      } else {
        await fetch('/api/resume_discard', { method: 'POST' });
      }
    }
  } catch (e) {}
  scanVideos();
});

// ── GPU + Model check ──
async function checkGPU() {
  try {
    const res = await fetch('/api/system');
    const info = await res.json();
    const banner = $('gpuBanner');
    if (info.gpu_verified) {
      banner.className = 'gpu-banner gpu-on';
      $('gpuText').textContent = '统一 Turbo GPU 算子：最近任务已完成 CUDA 转写';
    } else if (info.resources_ready) {
      banner.className = 'gpu-banner';
      $('gpuText').textContent = '统一 Turbo GPU 算子：入口资源就绪，任务启动时验证 GPU';
    } else {
      banner.className = 'gpu-banner gpu-off';
      $('gpuText').textContent = info.error || 'GPU 算子入口未就绪，请检查统一算子目录';
    }
  } catch (e) {
    $('gpuText').textContent = '无法检查 GPU 算子入口';
  }
  // Load model list
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const sel = $('modelSelect');
    sel.textContent = `${data.current} · Native30 · CUDA FP16`;
  } catch (e) {}
  // Check model loading status
  checkModel();
}

async function checkModel() {
  try {
    const res = await fetch('/api/model_status');
    const info = await res.json();
    if (info.ready) {
      $('modelBanner').style.display = 'none';
    } else if (info.loading) {
      $('modelBanner').style.display = 'flex';
      $('modelText').textContent = '正在检查统一算子资源，不载入 GPU 模型...';
      setTimeout(checkModel, 2000);
    }
  } catch (e) {}
}

// ── Shutdown ──
async function shutdownServer() {
  const msg = isTranscribing
    ? '正在转写中！关闭将中断当前任务（进度已保存）。确定关闭？'
    : '确定要关闭服务吗？';
  const ok = await showConfirm('关闭服务', msg);
  if (!ok) return;
  try {
    await fetch('/api/shutdown', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ force: isTranscribing }),
    });
  } catch (e) { /* server stopped */ }
  document.body.innerHTML = '<div style="text-align:center;padding:80px"><h2>服务已关闭</h2><p style="color:#a3a3a3;margin-top:12px">可关闭此页面</p></div>';
}
