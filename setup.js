/**
 * Ink Aural – setup.js
 * 初回セットアップ画面のレンダラーロジック
 */

'use strict'

// ──────────────────────────────────────
//  ステップ定義
// ──────────────────────────────────────
const STEPS = [
  {
    id: 'python',
    title: 'Python 環境の確認',
    desc: 'Python 3.9 以上が必要です'
  },
  {
    id: 'easyocr',
    title: 'EasyOCR のインストール',
    desc: 'OCR エンジン（初回は数分かかります）'
  },
  {
    id: 'manga-ocr',
    title: 'manga-ocr のインストール（オプション）',
    desc: '高精度 OCR エンジン（装飾フォント対応）'
  },
  {
    id: 'openjtalk',
    title: 'Open JTalk のインストール（Linux のみ）',
    desc: '日本語 TTS エンジン'
  }
]

// ──────────────────────────────────────
//  DOM 構築
// ──────────────────────────────────────
const stepsEl = document.getElementById('steps')

function buildSteps() {
  stepsEl.innerHTML = ''
  STEPS.forEach(s => {
    const div = document.createElement('div')
    div.className = 'step pending'
    div.id = `step-${s.id}`
    div.innerHTML = `
      <div class="step-icon" id="icon-${s.id}">○</div>
      <div class="step-body">
        <div class="step-title">${s.title}</div>
        <div class="step-msg" id="msg-${s.id}">${s.desc}</div>
      </div>
    `
    stepsEl.appendChild(div)
  })
}

buildSteps()

// ──────────────────────────────────────
//  ヘルパー
// ──────────────────────────────────────
const logBox = document.getElementById('log-box')
const MAX_LOG_LINES = 120

function appendLog(text, isErr = false) {
  const line = document.createElement('div')
  line.className = 'log-line' + (isErr ? ' err' : '')
  line.textContent = text
  logBox.appendChild(line)
  // 行数制限
  while (logBox.childElementCount > MAX_LOG_LINES) {
    logBox.removeChild(logBox.firstChild)
  }
  logBox.scrollTop = logBox.scrollHeight
}

const ICONS = {
  pending: '○',
  running: '<span class="spinner"></span>',
  ok:      '✔',
  error:   '✖',
  skip:    '—'
}

function setStep(id, status, message) {
  const stepEl = document.getElementById(`step-${id}`)
  const iconEl = document.getElementById(`icon-${id}`)
  const msgEl  = document.getElementById(`msg-${id}`)

  if (!stepEl) return

  // クラスをリセットして新しいステータスを付与
  stepEl.className = `step ${status}`
  iconEl.innerHTML = ICONS[status] || '○'
  if (message) msgEl.textContent = message
}

// ──────────────────────────────────────
//  IPC イベントハンドラ
// ──────────────────────────────────────
window.inkAural.onSetupLog(({ step, status, message }) => {
  setStep(step, status, message)
  const isErr = status === 'error'
  appendLog(`[${step}] ${message}`, isErr)
})

window.inkAural.onSetupDone(({ success }) => {
  const btnStart = document.getElementById('btn-start')
  const btnSkip  = document.getElementById('btn-skip')
  const btnOpen  = document.getElementById('btn-open')
  const banner   = document.getElementById('done-banner')

  btnStart.disabled = false
  btnSkip.disabled  = false

  if (success) {
    banner.classList.add('show')
    btnOpen.style.display = 'inline-block'
    btnStart.style.display = 'none'
    btnSkip.style.display  = 'none'
    appendLog('▶ セットアップ完了。「Ink Aural を起動」ボタンを押してください。')
  } else {
    appendLog('✖ セットアップ中にエラーが発生しました。ログを確認してください。', true)
    btnStart.textContent = '再試行'
  }
})

// ──────────────────────────────────────
//  ボタンロジック
// ──────────────────────────────────────
const btnStart = document.getElementById('btn-start')
const btnSkip  = document.getElementById('btn-skip')
const btnOpen  = document.getElementById('btn-open')

btnStart.addEventListener('click', async () => {
  // ステップをリセット
  buildSteps()
  logBox.innerHTML = ''
  document.getElementById('done-banner').classList.remove('show')
  btnStart.disabled = true
  btnSkip.disabled  = true
  btnOpen.style.display = 'none'

  appendLog('▶ セットアップを開始します...')
  const platform = navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux'
  appendLog(`  OS: ${platform}`)

  await window.inkAural.runSetup(platform)
  // 結果は onSetupDone で受け取る
})

btnSkip.addEventListener('click', async () => {
  // セットアップをスキップしてメイン画面へ
  if (!confirm('セットアップをスキップします。\nOCRやTTSが動作しない場合は手動でインストールしてください。')) return
  await window.inkAural.completeSetup()
})

btnOpen.addEventListener('click', async () => {
  await window.inkAural.completeSetup()
})
