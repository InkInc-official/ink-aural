const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('inkAural', {
  // ── カメラ ──
  getCameras: () => ipcRenderer.invoke('get-cameras'),

  // ── 読み上げ制御 ──
  startReading: (config) => ipcRenderer.invoke('start-reading', config),
  stopReading: () => ipcRenderer.invoke('stop-reading'),
  updateSpeed: (speed) => ipcRenderer.invoke('update-speed', speed),
  sendFrame: (base64Frame) => ipcRenderer.send('send-frame-sync', base64Frame),

  // ── 外部リンク ──
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ── スクリーンショット ──
  saveScreenshot: (base64Data) => ipcRenderer.invoke('save-screenshot', base64Data),
  openXPost: (text) => ipcRenderer.invoke('open-x-post', text),

  // ── メモ・話題ストック ──
  saveNotes: (notes) => ipcRenderer.invoke('save-notes', notes),
  loadNotes: () => ipcRenderer.invoke('load-notes'),

  // ── Pythonからのイベント受信 ──
  onNewComment:      (cb) => ipcRenderer.on('new-comment',       (_, d) => cb(d)),
  onRequestFrame:    (cb) => ipcRenderer.on('request-frame',     ()    => cb()),
  onCameraList:      (cb) => ipcRenderer.on('camera-list',       (_, d) => cb(d)),
  onPythonStatus:    (cb) => ipcRenderer.on('python-status',     (_, d) => cb(d)),
  onPythonError:     (cb) => ipcRenderer.on('python-error',      (_, d) => cb(d)),
  onPythonClosed:    (cb) => ipcRenderer.on('python-closed',     (_, d) => cb(d)),
  onTtsStart:        (cb) => ipcRenderer.on('tts-start',         (_, d) => cb(d)),
  onTtsEnd:          (cb) => ipcRenderer.on('tts-end',           (_, d) => cb(d)),
  onTrayStatusChange:(cb) => ipcRenderer.on('tray-status-change',(_, d) => cb(d)),

  // ── リスナー解除ユーティリティ ──
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // ── セットアップ（初回起動） ──
  runSetup: (platform) => ipcRenderer.invoke('setup-run', platform),
  onSetupLog: (cb) => ipcRenderer.on('setup-log', (_, d) => cb(d)),
  onSetupDone: (cb) => ipcRenderer.on('setup-done', (_, d) => cb(d)),
  completeSetup: () => ipcRenderer.invoke('setup-complete')
})
