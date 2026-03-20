const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const Store = require('electron-store')

const store = new Store()

let mainWindow  = null
let setupWindow = null
let tray        = null
let pythonProcess = null
let isReading   = false

// ────────────────────────────────
//  Python実行パスの解決
//  Windows: python / Ubuntu: python3
// ────────────────────────────────
function getPythonPath() {
  const platform = process.platform
  if (platform === 'win32') {
    // バンドル版Python（将来のexe配布用）があれば優先
    const bundled = path.join(process.resourcesPath, 'python', 'python.exe')
    if (fs.existsSync(bundled)) return bundled
    return 'python'
  }
  return 'python3'
}

// ────────────────────────────────
//  Pythonワーカー起動
// ────────────────────────────────
function startPythonWorker() {
  if (pythonProcess) return

  // ビルド版（asar）では __dirname が asar 内を指すため
  // extraResources で配置した resourcesPath/python を優先する
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'ocr_worker.py')
    : path.join(__dirname, 'python', 'ocr_worker.py')
  const pythonPath = getPythonPath()

  console.log(`[Main] Python起動: ${pythonPath} ${scriptPath}`)

  pythonProcess = spawn(pythonPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    }
  })

  // stdinを開いたままにする（閉じるとPythonのfor line in sys.stdinが終了する）
  pythonProcess.stdin.on('error', (e) => {
    console.warn('[Main] Python stdin error:', e.message)
  })

  // Pythonからのメッセージ受信（JSONLines形式）
  let buffer = ''
  pythonProcess.stdout.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() // 末尾の不完全行を保持

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        handlePythonMessage(msg)
      } catch (e) {
        console.warn('[Main] Pythonメッセージ解析失敗:', trimmed)
      }
    }
  })

  pythonProcess.stderr.on('data', (data) => {
    console.error('[Python]', data.toString())
    // UIにもエラーを通知
    if (mainWindow) {
      mainWindow.webContents.send('python-error', data.toString())
    }
  })

  pythonProcess.on('close', (code) => {
    console.log(`[Main] Pythonプロセス終了: code=${code}`)
    pythonProcess = null
    if (mainWindow) {
      mainWindow.webContents.send('python-closed', code)
    }
    // 異常終了（code !== 0）かつアプリ終了中でなければ再起動
    if (code !== 0 && !app.isQuitting) {
      console.log('[Main] Python異常終了 → 3秒後に再起動')
      setTimeout(() => {
        if (!app.isQuitting) startPythonWorker()
      }, 3000)
    }
  })
}

// ────────────────────────────────
//  Pythonからのメッセージをレンダラーへ転送
// ────────────────────────────────
function handlePythonMessage(msg) {
  if (!mainWindow) return
  switch (msg.type) {
    case 'request-frame':
      mainWindow.webContents.send('request-frame')
      break
    case 'comment':
      mainWindow.webContents.send('new-comment', msg)
      break
    case 'camera-list':
      mainWindow.webContents.send('camera-list', msg.cameras)
      break
    case 'status':
      mainWindow.webContents.send('python-status', msg)
      break
    case 'tts-start':
      mainWindow.webContents.send('tts-start', msg)
      break
    case 'tts-end':
      mainWindow.webContents.send('tts-end', msg)
      break
    default:
      mainWindow.webContents.send('python-msg', msg)
  }
}

// ────────────────────────────────
//  レンダラー → Python へコマンド送信
// ────────────────────────────────
function sendToPython(cmd) {
  if (!pythonProcess || !pythonProcess.stdin.writable) {
    console.warn('[Main] Pythonプロセスが利用不可')
    return false
  }
  pythonProcess.stdin.write(JSON.stringify(cmd) + '\n')
  return true
}

// ────────────────────────────────
//  IPC ハンドラ（レンダラーからの指示）
// ────────────────────────────────
ipcMain.handle('get-cameras', async () => {
  sendToPython({ action: 'get-cameras' })
})

ipcMain.handle('start-reading', async (event, config) => {
  isReading = true
  // カメラインデックスは不要（Electron側でキャプチャするため）
  sendToPython({ action: 'start', ...config, cameraIndex: -1 })
  updateTray()
})

// フレームはinvokeではなくsend（一方向）で詰まりを防ぐ
ipcMain.on('send-frame-sync', (event, base64Frame) => {
  sendToPython({ action: 'frame', data: base64Frame })
})

ipcMain.handle('update-speed', async (event, speed) => {
  sendToPython({ action: 'update-speed', speed })
})

ipcMain.handle('stop-reading', async () => {
  isReading = false
  sendToPython({ action: 'stop' })
  updateTray()
})

ipcMain.handle('save-screenshot', async (event, base64Data) => {
  const downloadsPath = app.getPath('downloads')
  const filename = `ink-aural-${Date.now()}.png`
  const filePath = path.join(downloadsPath, filename)
  const data = base64Data.replace(/^data:image\/\w+;base64,/, '')
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
  return filePath
})

ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron')
  shell.openExternal(url)
})

ipcMain.handle('open-x-post', async (event, text) => {
  const { shell } = require('electron')
  const encoded = encodeURIComponent(text || '')
  shell.openExternal(`https://twitter.com/intent/tweet?text=${encoded}`)
})

ipcMain.handle('save-notes', async (event, notes) => {
  const notesPath = path.join(app.getPath('userData'), 'notes.json')
  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2), 'utf-8')
  return true
})

ipcMain.handle('load-notes', async () => {
  const notesPath = path.join(app.getPath('userData'), 'notes.json')
  if (fs.existsSync(notesPath)) {
    return JSON.parse(fs.readFileSync(notesPath, 'utf-8'))
  }
  return { memo: '', topics: [] }
})

// ────────────────────────────────
//  タスクトレイ
// ────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'logo.png')
  const icon = require('fs').existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 })
    : nativeImage.createEmpty()
  tray = new Tray(icon)
  updateTray()
}

function updateTray() {
  if (!tray) return
  const status = isReading ? '読み上げ中' : '停止中'
  tray.setToolTip(`Ink Aural - ${status}`)

  const contextMenu = Menu.buildFromTemplate([
    { label: `状態: ${status}`, enabled: false },
    { type: 'separator' },
    {
      label: isReading ? '一時停止' : '再開',
      click: () => {
        if (isReading) {
          isReading = false
          sendToPython({ action: 'stop' })
        } else {
          isReading = true
          sendToPython({ action: 'resume' })
        }
        updateTray()
        if (mainWindow) mainWindow.webContents.send('tray-status-change', isReading)
      }
    },
    { label: '設定を開く', click: () => { if (mainWindow) mainWindow.show() } },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ])
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
    }
  })
}

// ────────────────────────────────
//  ウィンドウ生成
// ────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Ink Aural',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile('index.html')

  // 閉じたらトレイに格納（終了ではない）
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// ────────────────────────────────
//  セットアップ完了フラグの管理
// ────────────────────────────────
function isSetupComplete() {
  return store.get('setupComplete', false)
}

// ────────────────────────────────
//  セットアップウィンドウ生成
// ────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 680,
    height: 560,
    resizable: false,
    backgroundColor: '#0a0a0a',
    title: 'Ink Aural — 初回セットアップ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setupWindow.setMenuBarVisibility(false)
  setupWindow.loadFile('setup.html')
  setupWindow.on('closed', () => { setupWindow = null })
}

// ────────────────────────────────
//  セットアップ IPC ハンドラ
// ────────────────────────────────

/**
 * セットアップ実行：platform='linux'|'win32'
 * 各ステップの進捗を 'setup-log' イベントでレンダラーに流す
 */
ipcMain.handle('setup-run', async (event, platform) => {
  const win = setupWindow || mainWindow

  function log(step, status, message) {
    // status: 'running' | 'ok' | 'error' | 'skip'
    if (win) win.webContents.send('setup-log', { step, status, message })
  }

  const pipCmd  = platform === 'win32' ? 'pip' : 'pip3'
  const pyCmd   = platform === 'win32' ? 'python' : 'python3'

  // ── Step 1: Python確認 ──
  log('python', 'running', 'Python環境を確認中...')
  try {
    const ver = execSync(`${pyCmd} --version`, { timeout: 8000 }).toString().trim()
    log('python', 'ok', `${ver} を確認`)
  } catch (e) {
    log('python', 'error', 'Pythonが見つかりません。Python 3.9以上をインストールしてください。')
    if (win) win.webContents.send('setup-done', { success: false })
    return { success: false }
  }

  // ── Step 2: EasyOCR インストール ──
  log('easyocr', 'running', 'EasyOCRをインストール中（初回は数分かかります）...')
  const pipBaseArgs = platform === 'win32'
    ? [pipCmd, 'install', 'easyocr', 'numpy<2.0', 'emoji']
    : [pipCmd, 'install', 'easyocr', 'numpy<2.0', 'emoji', '--break-system-packages']
  try {
    await runCommand(pipBaseArgs[0], pipBaseArgs.slice(1), (line) => {
      log('easyocr', 'running', line)
    })
    log('easyocr', 'ok', 'EasyOCR インストール完了')
  } catch (e) {
    log('easyocr', 'error', `EasyOCR インストール失敗: ${e.message}`)
    if (win) win.webContents.send('setup-done', { success: false })
    return { success: false }
  }

  // ── Step 3: manga-ocr インストール（任意・失敗してもスキップ） ──
  log('manga-ocr', 'running', 'manga-ocr をインストール中（オプション）...')
  const mangaArgs = platform === 'win32'
    ? [pipCmd, 'install', 'manga-ocr']
    : [pipCmd, 'install', 'manga-ocr', '--break-system-packages']
  try {
    await runCommand(mangaArgs[0], mangaArgs.slice(1), (line) => {
      log('manga-ocr', 'running', line)
    })
    log('manga-ocr', 'ok', 'manga-ocr インストール完了（高精度OCRが使用可能）')
  } catch (e) {
    log('manga-ocr', 'skip', 'manga-ocr は任意のため、スキップしました')
  }

  // ── Step 4: Open JTalk (Linux のみ) ──
  if (platform === 'linux') {
    log('openjtalk', 'running', 'Open JTalk（TTS）を確認中...')
    try {
      execSync('which open_jtalk', { timeout: 5000 })
      log('openjtalk', 'ok', 'Open JTalk は既にインストール済みです')
    } catch {
      log('openjtalk', 'running', 'Open JTalk をインストール中（sudoが必要です）...')
      try {
        await runCommand('pkexec', [
          'apt', 'install', '-y',
          'open-jtalk',
          'open-jtalk-mecab-naist-jdic',
          'hts-voice-nitech-jp-atr503-m001'
        ], (line) => {
          log('openjtalk', 'running', line)
        })
        log('openjtalk', 'ok', 'Open JTalk インストール完了')
      } catch (e) {
        log('openjtalk', 'error', `Open JTalk インストール失敗: ${e.message}\n手動でインストールしてください:\nsudo apt install open-jtalk open-jtalk-mecab-naist-jdic hts-voice-nitech-jp-atr503-m001`)
      }
    }
  } else {
    // Windows: pyttsx3をインストール
    log('openjtalk', 'running', 'pyttsx3（Windows TTS）をインストール中...')
    try {
      await runCommand('pip', ['install', 'pyttsx3'], (line) => {
        log('openjtalk', 'running', line)
      })
      log('openjtalk', 'ok', 'pyttsx3 インストール完了（Windows TTS使用）')
    } catch (e) {
      log('openjtalk', 'error', `pyttsx3 インストール失敗: ${e.message}`)
    }
  }

  // ── Step 5: 完了 ──
  log('done', 'ok', 'セットアップ完了！')
  if (win) win.webContents.send('setup-done', { success: true })
  return { success: true }
})

/**
 * セットアップ完了を記録してメイン画面を開く
 */
ipcMain.handle('setup-complete', async () => {
  store.set('setupComplete', true)
  if (setupWindow) {
    setupWindow.close()
    setupWindow = null
  }
  createWindow()
  createTray()
  startPythonWorker()
})

/**
 * 子プロセスをPromise化して実行し、stdoutを行単位でコールバックに流す
 */
function runCommand(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false })
    let stderr = ''

    proc.stdout.on('data', (d) => {
      const lines = d.toString().split(/\r?\n/).filter(Boolean)
      lines.forEach(onLine)
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      const lines = d.toString().split(/\r?\n/).filter(Boolean)
      lines.forEach(onLine)
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.slice(-200) || `exit code ${code}`))
    })
    proc.on('error', (e) => reject(e))
  })
}

// ────────────────────────────────
//  アプリライフサイクル
// ────────────────────────────────
app.whenReady().then(() => {
  if (!isSetupComplete()) {
    // 初回起動 → セットアップ画面
    createSetupWindow()
  } else {
    // セットアップ済み → メイン画面
    createWindow()
    createTray()
    startPythonWorker()
  }

  // カメラ・マイクのアクセス権限を自動許可
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
    } else {
      callback(false)
    }
  })

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') return true
    return false
  })
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (pythonProcess) {
    sendToPython({ action: 'quit' })
    pythonProcess.kill()
  }
})

app.on('window-all-closed', () => {
  // macOSはDockに残す慣例だが、このアプリはトレイ常駐
  if (process.platform !== 'darwin') {
    // 何もしない（トレイに残す）
  }
})
