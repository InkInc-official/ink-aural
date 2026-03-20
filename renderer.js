/* ════════════════════════════════════════════
   Ink Aural – renderer.js  v0.0.2
════════════════════════════════════════════ */

const api = window.inkAural
const $   = (id) => document.getElementById(id)

// ── DOM ──
const statusDot      = $('status-dot')
const statusText     = $('status-text')
const cameraVideo    = $('camera-video')
const cameraCanvas   = $('camera-canvas')
const noCameraEl     = $('no-camera')
const guideBox       = $('guide-box')
const guideResize    = $('guide-resize')
const cameraSelect   = $('camera-select')
const audioOutSelect = $('audio-out-select')
const commentLog     = $('comment-log')
const speedSlider    = $('speed-slider')
const speedVal       = $('speed-val')
const memoArea       = $('memo-area')
const memoTitleInput = $('memo-title-input')
const memoList       = $('memo-list')
const topicList      = $('topic-list')
const topicInput     = $('topic-input')
const screenshotInline        = $('screenshot-inline')
const screenshotPreviewInline = $('screenshot-preview-inline')
const activityBar          = $('activity-bar')
const screenshotModal      = $('screenshot-modal')
const screenshotModalImg   = $('screenshot-modal-img')

// ── 状態 ──
let isReading       = false
let isRecording     = false
let mediaStream     = null
let mediaRecorder   = null
let recordChunks    = []
let notes           = { memos: [], topics: [] }
let activeMemoIndex = null
let screenshotDataUrl = null

// ════════════════════════════════════════════
//  起動
// ════════════════════════════════════════════
async function init() {
  await loadCameras()
  await loadAudioOutputs()
  await loadNotes()
  setupGuideBox()
  setupResizeHandles()
  setupLinks()
  setupEvents()
  setupPythonListeners()
  setStatus('STANDBY', '')
}

// ════════════════════════════════════════════
//  カメラ
// ════════════════════════════════════════════
async function loadCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const videoDevices = devices.filter(d => d.kind === 'videoinput')
  cameraSelect.innerHTML = '<option value="">-- USBカメラを選択 --</option>'
  if (videoDevices.length === 0) {
    // デバイスが見つからない場合は権限を取得してから再列挙
    try {
      await navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()))
      const retry = await navigator.mediaDevices.enumerateDevices()
      retry.filter(d => d.kind === 'videoinput').forEach((d, i) => {
        const opt = document.createElement('option')
        opt.value = d.deviceId
        opt.textContent = d.label || `カメラ ${i + 1}`
        cameraSelect.appendChild(opt)
      })
    } catch (_) {}
    return
  }
  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label || `カメラ ${i + 1}`
    cameraSelect.appendChild(opt)
  })
}

async function loadAudioOutputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter(d => d.kind === 'audiooutput')
    audioOutSelect.innerHTML = '<option value="default">デフォルト出力</option>'
    outputs.forEach((d, i) => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || `出力 ${i + 1}`
      audioOutSelect.appendChild(opt)
    })
  } catch (_) {}
}

async function startCamera(deviceId) {
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }
    })
    cameraVideo.srcObject = mediaStream
    noCameraEl.classList.add('hidden')
    enableCameraButtons(true)
  } catch (e) {
    showToast('カメラの起動に失敗しました: ' + e.message)
    noCameraEl.classList.remove('hidden')
    enableCameraButtons(false)
  }
}

function enableCameraButtons(on) {
  $('btn-start').disabled      = !on
  $('btn-screenshot').disabled  = !on
  $('btn-rec-start').disabled   = !on || isRecording
}

// ════════════════════════════════════════════
//  カラムリサイズハンドル
// ════════════════════════════════════════════
function setupResizeHandles() {
  setupHandle('handle-ab', 'col-a', 'col-b', 'left')
  setupHandle('handle-bc', 'col-b', 'col-c', 'right')
}

function setupHandle(handleId, colLeftId, colRightId, shrinkSide) {
  const handle  = $(handleId)
  const colLeft  = $(colLeftId)
  const colRight = $(colRightId)

  let startX, startLeftW, startRightW

  handle.addEventListener('mousedown', (e) => {
    startX      = e.clientX
    startLeftW  = colLeft.offsetWidth
    startRightW = colRight.offsetWidth
    handle.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })

  document.addEventListener('mousemove', (e) => {
    if (!handle.classList.contains('dragging')) return
    const dx = e.clientX - startX
    const newLeft  = Math.max(180, startLeftW  + dx)
    const newRight = Math.max(180, startRightW - dx)
    colLeft.style.width    = newLeft  + 'px'
    colLeft.style.minWidth = newLeft  + 'px'
    colLeft.style.flex     = 'none'
    colRight.style.width    = newRight + 'px'
    colRight.style.minWidth = newRight + 'px'
    colRight.style.flex     = 'none'
  })

  document.addEventListener('mouseup', () => {
    if (!handle.classList.contains('dragging')) return
    handle.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })
}

// ════════════════════════════════════════════
//  ガイド枠
// ════════════════════════════════════════════
function setupGuideBox() {
  let dragging = false, resizing = false
  let startX, startY, startLeft, startTop, startW, startH

  guideBox.addEventListener('mousedown', (e) => {
    if (e.target === guideResize) return
    dragging = true
    startX = e.clientX; startY = e.clientY
    startLeft = guideBox.offsetLeft; startTop = guideBox.offsetTop
    e.preventDefault()
  })
  guideResize.addEventListener('mousedown', (e) => {
    resizing = true
    startX = e.clientX; startY = e.clientY
    startW = guideBox.offsetWidth; startH = guideBox.offsetHeight
    e.preventDefault(); e.stopPropagation()
  })
  document.addEventListener('mousemove', (e) => {
    if (dragging) {
      guideBox.style.left = (startLeft + e.clientX - startX) + 'px'
      guideBox.style.top  = (startTop  + e.clientY - startY) + 'px'
    }
    if (resizing) {
      guideBox.style.width  = Math.max(80,  startW + e.clientX - startX) + 'px'
      guideBox.style.height = Math.max(40,  startH + e.clientY - startY) + 'px'
    }
  })
  document.addEventListener('mouseup', () => { dragging = false; resizing = false })
}

function getGuideBoxROI() {
  const cRect = $('camera-container').getBoundingClientRect()
  const gRect = guideBox.getBoundingClientRect()
  const scaleX = cameraVideo.videoWidth  / cRect.width
  const scaleY = cameraVideo.videoHeight / cRect.height
  return {
    x: Math.round((gRect.left - cRect.left) * scaleX),
    y: Math.round((gRect.top  - cRect.top)  * scaleY),
    w: Math.round(gRect.width  * scaleX),
    h: Math.round(gRect.height * scaleY)
  }
}

// ════════════════════════════════════════════
//  コメントログ
// ════════════════════════════════════════════
function classifyComment(text) {
  if (text.includes('を贈りました'))   return 'gift'
  if (text.includes('を獲得しました')) return 'badge'
  if (text.includes('を超えました'))   return 'kiri'
  return 'normal'
}

function addCommentToLog(text, type) {
  const placeholder = commentLog.querySelector('[data-placeholder]')
  if (placeholder) placeholder.remove()
  while (commentLog.children.length >= 200) commentLog.removeChild(commentLog.lastChild)
  const kind = type || classifyComment(text)
  const hhmm = new Date().toTimeString().slice(0, 5)
  const item = document.createElement('div')
  item.className = `comment-item ${kind}`
  item.innerHTML = `<span class="comment-time">${hhmm}</span><span class="comment-text">${escapeHtml(text)}</span>`
  commentLog.insertBefore(item, commentLog.firstChild)
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ════════════════════════════════════════════
//  スクリーンショット（インライン表示）
// ════════════════════════════════════════════
function takeScreenshot() {
  if (!mediaStream) return
  cameraCanvas.width  = cameraVideo.videoWidth
  cameraCanvas.height = cameraVideo.videoHeight
  cameraCanvas.getContext('2d').drawImage(cameraVideo, 0, 0)
  screenshotDataUrl = cameraCanvas.toDataURL('image/png')
  screenshotPreviewInline.src = screenshotDataUrl
  screenshotInline.classList.add('visible')
  // Cカラムのスクロールをスクショまで移動
  screenshotInline.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// ════════════════════════════════════════════
//  録画
// ════════════════════════════════════════════
function startRecording() {
  if (!mediaStream || isRecording) return
  recordChunks = []
  // mp4対応確認、なければwebm
  const mimeType = MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : 'video/webm;codecs=vp8'
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType })
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordChunks.push(e.data) }
  mediaRecorder.onstop = saveRecording
  mediaRecorder.start(1000)
  isRecording = true
  $('btn-rec-start').disabled = true
  $('btn-rec-stop').disabled  = false
  updateActivityBar()
  showToast('画面録画を開始しました')
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return
  mediaRecorder.stop()
  isRecording = false
  $('btn-rec-start').disabled = false
  $('btn-rec-stop').disabled  = true
  updateActivityBar()
}

function saveRecording() {
  const isMP4 = mediaRecorder && mediaRecorder.mimeType.includes('mp4')
  const ext  = isMP4 ? 'mp4' : 'webm'
  const type = isMP4 ? 'video/mp4' : 'video/webm'
  const blob = new Blob(recordChunks, { type })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `ink-aural-rec-${Date.now()}.${ext}`; a.click()
  URL.revokeObjectURL(url)
  showToast('録画を保存しました')
}



// ════════════════════════════════════════════
//  メモ（タイトル付きリスト管理 + テキストエリア）
// ════════════════════════════════════════════
async function loadNotes() {
  notes = await api.loadNotes()
  if (!notes.memos)  notes.memos  = []
  if (!notes.topics) notes.topics = []
  renderMemoList()
  renderTopics()
}

function renderMemoList() {
  memoList.innerHTML = ''
  notes.memos.forEach((memo, i) => {
    const item = document.createElement('div')
    item.className = 'memo-item' + (i === activeMemoIndex ? ' active' : '')
    item.innerHTML = `
      <span class="memo-item-title">${escapeHtml(memo.title || '無題')}</span>
      <span class="memo-item-date">${memo.date || ''}</span>
      <button class="memo-del" data-i="${i}">×</button>
    `
    // クリックで読み込み
    item.querySelector('.memo-item-title').addEventListener('click', () => {
      activeMemoIndex = i
      memoArea.value = memo.content || ''
      memoTitleInput.value = memo.title || ''
      renderMemoList()
    })
    item.querySelector('.memo-del').addEventListener('click', (e) => {
      e.stopPropagation()
      notes.memos.splice(i, 1)
      if (activeMemoIndex === i) { activeMemoIndex = null; memoArea.value = ''; memoTitleInput.value = '' }
      else if (activeMemoIndex > i) activeMemoIndex--
      api.saveNotes(notes)
      renderMemoList()
    })
    memoList.appendChild(item)
  })
}

function saveMemo() {
  const content = memoArea.value
  const title   = memoTitleInput.value.trim() || '無題'
  const date    = new Date().toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' })
  if (activeMemoIndex !== null && notes.memos[activeMemoIndex]) {
    notes.memos[activeMemoIndex] = { title, content, date }
  } else {
    notes.memos.unshift({ title, content, date })
    activeMemoIndex = 0
  }
  api.saveNotes(notes)
  renderMemoList()
  showToast(`メモを保存: ${title}`)
}

// ════════════════════════════════════════════
//  話題ストック
// ════════════════════════════════════════════
function renderTopics() {
  topicList.innerHTML = ''
  ;(notes.topics || []).forEach((topic, i) => {
    const item = document.createElement('div')
    item.className = 'topic-item'
    item.innerHTML = `<span>${escapeHtml(topic)}</span><button class="topic-del" data-i="${i}">×</button>`
    topicList.appendChild(item)
  })
  topicList.querySelectorAll('.topic-del').forEach(btn => {
    btn.addEventListener('click', () => {
      notes.topics.splice(parseInt(btn.dataset.i), 1)
      api.saveNotes(notes)
      renderTopics()
    })
  })
}

// ════════════════════════════════════════════
//  X投稿（テンプレート付き）
// ════════════════════════════════════════════
function openXPost() {
  const template = '\n\n#InkAural #InkInc\nhttps://inkinc-hp.vercel.app/tools'
  api.openXPost(template)
}

// ════════════════════════════════════════════
//  フレーム送信ループ（Electron→Python）
// ════════════════════════════════════════════
let frameTimer = null

function startFrameLoop() {
  stopFrameLoop()
  const offscreen = document.createElement('canvas')

  frameTimer = setInterval(() => {
    if (!mediaStream || !cameraVideo.videoWidth || !isReading) return

    const cRect = $('camera-container').getBoundingClientRect()
    const gRect = guideBox.getBoundingClientRect()
    const scaleX = cameraVideo.videoWidth  / cRect.width
    const scaleY = cameraVideo.videoHeight / cRect.height
    const rx = Math.max(0, Math.round((gRect.left - cRect.left) * scaleX))
    const ry = Math.max(0, Math.round((gRect.top  - cRect.top)  * scaleY))
    const rw = Math.max(1, Math.round(gRect.width  * scaleX))
    const rh = Math.max(1, Math.round(gRect.height * scaleY))

    offscreen.width  = rw
    offscreen.height = rh
    try {
      offscreen.getContext('2d').drawImage(cameraVideo, rx, ry, rw, rh, 0, 0, rw, rh)
      const base64 = offscreen.toDataURL('image/jpeg', 0.7).split(',')[1]
      api.sendFrame(base64)
    } catch (_) {}
  }, 3000)
}

function stopFrameLoop() {
  if (frameTimer) { clearInterval(frameTimer); frameTimer = null }
}

function captureAndSendFrame() {
  // タイマー方式では使用しない
}


function updateActivityBar() {
  activityBar.innerHTML = ''
  if (isReading) {
    const b = document.createElement('span')
    b.className = 'active-badge reading'
    b.textContent = '● 読み上げ機能起動中'
    activityBar.appendChild(b)
  }
  if (isRecording) {
    const b = document.createElement('span')
    b.className = 'active-badge recording'
    b.textContent = '● 画面録画中'
    activityBar.appendChild(b)
  }
}

// ════════════════════════════════════════════
//  スクショモーダル
// ════════════════════════════════════════════
function openScreenshotModal(src) {
  screenshotModalImg.src = src
  screenshotModal.classList.add('open')
}
function closeScreenshotModal() {
  screenshotModal.classList.remove('open')
}


function setStatus(text, state) {
  statusText.textContent = text
  statusDot.className = 'status-dot' + (state ? ' ' + state : '')
}

let toastTimer = null
function showToast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800)
}

// ════════════════════════════════════════════
//  リンク
// ════════════════════════════════════════════
function setupLinks() {
  document.querySelectorAll('[data-url]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      api.openExternal(el.dataset.url)
    })
  })
}

// ════════════════════════════════════════════
//  Python イベント受信
// ════════════════════════════════════════════
function setupPythonListeners() {
  api.onNewComment((msg) => addCommentToLog(msg.text, msg.kind))
  api.onRequestFrame(() => captureAndSendFrame())
  api.onPythonStatus((msg) => {
    if (msg.status === 'ready')   setStatus('READY', '')
    if (msg.status === 'running') setStatus('READING', 'reading')
    if (msg.status === 'stopped') setStatus('STOPPED', '')
  })
  api.onTtsStart(() => { const f = commentLog.firstElementChild; if (f) f.classList.add('reading') })
  api.onTtsEnd(()   => { const f = commentLog.firstElementChild; if (f) f.classList.remove('reading') })
  api.onPythonError((msg) => { setStatus('ERROR', 'error'); showToast('エラー: ' + msg.slice(0, 60)) })
  api.onPythonClosed((code) => { setStatus('OFFLINE', 'error'); showToast('Pythonプロセスが終了しました') })
  api.onTrayStatusChange((reading) => { isReading = reading; updateReadingUI() })
}

function updateReadingUI() {
  $('btn-start').disabled = isReading
  $('btn-stop').disabled  = !isReading
  if (isReading) setStatus('READING', 'reading')
  else           setStatus('STANDBY', '')
  updateActivityBar()
}

// ════════════════════════════════════════════
//  全イベント
// ════════════════════════════════════════════
function setupEvents() {
  // ロゴ → HP
  $('logo-btn').addEventListener('click', () => {
    api.openExternal('https://inkinc-hp.vercel.app/')
  })

  // カメラ
  cameraSelect.addEventListener('change', () => { if (cameraSelect.value) startCamera(cameraSelect.value) })
  $('btn-refresh-cam').addEventListener('click', () => { loadCameras(); showToast('カメラ一覧を更新しました') })

  // 読み上げ
  $('btn-start').addEventListener('click', async () => {
    const roi = getGuideBoxROI()
    const camIndex = [...cameraSelect.options].findIndex(o => o.value === cameraSelect.value) - 1
    const config = {
      cameraIndex: camIndex,
      roi,
      speed: parseInt(speedSlider.value),
      audioDevice: audioOutSelect.value
    }
    await api.startReading(config)
    isReading = true
    startFrameLoop()
    updateReadingUI()
    showToast('読み上げを開始しました')
  })
  $('btn-stop').addEventListener('click', async () => {
    await api.stopReading()
    isReading = false
    stopFrameLoop()
    updateReadingUI()
    showToast('読み上げを停止しました')
    // Electronのカメラを再開
    if (cameraSelect.value) startCamera(cameraSelect.value)
  })

  // 録画
  $('btn-rec-start').addEventListener('click', startRecording)
  $('btn-rec-stop').addEventListener('click', stopRecording)
  $('btn-rec-stop').disabled = true

  // スクショ
  $('btn-screenshot').addEventListener('click', takeScreenshot)
  $('btn-d-save').addEventListener('click', async () => {
    if (!screenshotDataUrl) return
    const filePath = await api.saveScreenshot(screenshotDataUrl)
    showToast('保存しました: ' + filePath)
    screenshotInline.classList.remove('visible')
    screenshotDataUrl = null
  })
  $('btn-d-post').addEventListener('click', () => openXPost())
  $('btn-d-close').addEventListener('click', () => {
    screenshotInline.classList.remove('visible')
    screenshotDataUrl = null
    screenshotPreviewInline.src = ''
  })

  // 速度
  speedSlider.addEventListener('input', () => {
    speedVal.textContent = speedSlider.value + '%'
    if (isReading) api.updateSpeed(parseInt(speedSlider.value))
  })

  // スクショ画像クリック→モーダル拡大
  screenshotPreviewInline.addEventListener('click', () => {
    if (screenshotDataUrl) openScreenshotModal(screenshotDataUrl)
  })
  $('screenshot-modal-close').addEventListener('click', closeScreenshotModal)
  screenshotModal.addEventListener('click', (e) => {
    if (e.target === screenshotModal) closeScreenshotModal()
  })
  screenshotModalImg.addEventListener('click', closeScreenshotModal)

  // X開く
  $('btn-open-x').addEventListener('click', openXPost)

  // メモ
  $('memo-save').addEventListener('click', saveMemo)
  memoArea.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 's') { saveMemo(); e.preventDefault() } })
  memoTitleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMemo() })

  // 話題ストック
  $('btn-topic-add').addEventListener('click', () => {
    const v = topicInput.value.trim()
    if (!v) return
    notes.topics.push(v); api.saveNotes(notes); renderTopics(); topicInput.value = ''
  })
  topicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-topic-add').click() })


}

// ════════════════════════════════════════════
//  起動
// ════════════════════════════════════════════
init()
