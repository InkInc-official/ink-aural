"""
Ink Aural – ocr_worker.py  v1.0.0
EasyOCR版・直列処理で重複防止
"""

import sys
import json
import time
import re
import threading
import subprocess
import shutil
import tempfile
import os
import base64
import warnings
warnings.filterwarnings('ignore')
os.environ['PYTHONWARNINGS'] = 'ignore'

# Windows環境でstdoutをUTF-8に強制（文字化け防止）
# PYTHONUTF8=1 が spawn 時に渡されるため、念のため明示的にも設定する
os.environ.setdefault('PYTHONUTF8', '1')

import numpy as np
import cv2
from collections import deque

try:
    import easyocr
    EASYOCR_OK = True
except ImportError:
    EASYOCR_OK = False

try:
    import emoji
    EMOJI_OK = True
except ImportError:
    EMOJI_OK = False

# ── TTS 初期化 ──────────────────────────────────────
IS_WIN  = sys.platform == 'win32'

# Linux: Open JTalk
TTS_OK      = shutil.which('open_jtalk') is not None
JTALK_DIC   = '/var/lib/mecab/dic/open-jtalk/naist-jdic'
JTALK_VOICE = '/usr/share/hts-voice/nitech-jp-atr503-m001/nitech_jp_atr503_m001.htsvoice'

running       = False
ocr_reader    = None
read_texts    = set()
visible_texts = set()
tts_queue     = deque()
tts_lock      = threading.Lock()
config        = {}

# フレームキュー（最新1件のみ保持）
pending_frame = [None]
frame_lock    = threading.Lock()
frame_event   = threading.Event()

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def send_status(status, msg=''):
    send({'type': 'status', 'status': status, 'msg': msg})

def send_comment(text, kind='normal'):
    send({'type': 'comment', 'text': text, 'kind': kind})

def init_ocr():
    global ocr_reader
    if not EASYOCR_OK:
        send_status('warn', 'EasyOCRが見つかりません')
        return False
    try:
        send_status('info', 'EasyOCR初期化中...')
        ocr_reader = easyocr.Reader(['ja', 'en'], gpu=False, verbose=False)
        send_status('info', 'EasyOCR準備完了')
        return True
    except Exception as e:
        send_status('warn', f'EasyOCR初期化失敗: {e}')
        return False

def init_tts():
    if IS_WIN:
        # subprocess経由でpyttsx3を呼ぶため、pyttsx3がインポートできるか確認するだけ
        try:
            import importlib
            importlib.import_module('pyttsx3')
            send_status('info', 'pyttsx3 TTS準備完了（Windows）')
            return True
        except ImportError:
            send_status('warn', 'pyttsx3が見つかりません。セットアップを再実行してください。')
            return False
    else:
        if not TTS_OK or not os.path.exists(JTALK_DIC) or not os.path.exists(JTALK_VOICE):
            send_status('warn', 'Open JTalk未インストール')
            return False
        send_status('info', 'Open JTalk TTS準備完了')
        return True

def speak(text: str, speed_pct: int = 100):
    if IS_WIN:
        # Windows: pyttsx3はCOMオブジェクトのため別プロセスで実行
        # sys.executable で自分自身のPythonパスを使う（PATH依存を回避）
        rate = int(180 * speed_pct / 100)
        send_status('info', f'TTS呼び出し: {sys.executable}')
        script = (
            'import pyttsx3; '
            'e=pyttsx3.init(); '
            f'e.setProperty("rate",{rate}); '
            f'e.say({repr(text)}); '
            'e.runAndWait()'
        )
        try:
            result = subprocess.run(
                [sys.executable, '-c', script],
                timeout=30,
                capture_output=True
            )
            send_status('info', f'TTS結果: returncode={result.returncode} stderr={result.stderr[:80]}')
        except Exception as e:
            send_status('warn', f'TTS例外: {e}')
    else:
        # Linux: Open JTalk
        if not TTS_OK:
            return
        speed = round(speed_pct / 100.0, 2)
        tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        tmp.close()
        try:
            proc = subprocess.run(
                ['open_jtalk', '-x', JTALK_DIC, '-m', JTALK_VOICE,
                 '-r', str(speed), '-ow', tmp.name],
                input=text.encode('utf-8'),
                capture_output=True, timeout=10
            )
            if proc.returncode != 0:
                return
            subprocess.run(['aplay', '-D', 'default', tmp.name],
                           capture_output=True, timeout=30)
        except Exception:
            pass
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

_RE_EMOJI = re.compile("["
    u"\U0001F600-\U0001F64F"
    u"\U0001F300-\U0001F5FF"
    u"\U0001F680-\U0001F6FF"
    u"\U0001F1E0-\U0001F1FF"
    u"\U00002702-\U000027B0"
    u"\U000024C2-\U0001F251"
    "]+", flags=re.UNICODE)
_RE_SPECIAL       = re.compile(r'[★☆◆◇■□▲▼●○♥♡♦♤♠♣♜♝♞♟]')
_RE_PT            = re.compile(r'\((\d+)\s*pt\)')
_RE_NOISE         = re.compile(r'^[\s\W\d]+$')
_RE_EMOJI_MISREAD = re.compile(r'^[林森水火土木金空花草葉光@*#&%$]{1,2}$')

def clean_text(text: str) -> str:
    if EMOJI_OK:
        text = emoji.replace_emoji(text, replace='')
    else:
        text = _RE_EMOJI.sub('', text)
    text = _RE_SPECIAL.sub('', text)
    text = _RE_PT.sub(r'\1pt', text)
    text = re.sub(r'^[\s\W]+', '', text)
    return text.strip()

def classify_comment(text: str) -> str:
    if 'を贈りました' in text:   return 'gift'
    if 'を獲得しました' in text: return 'badge'
    if 'を超えました' in text:   return 'kiri'
    return 'normal'

def edit_distance(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 5:
        return 999
    la, lb = len(a), len(b)
    dp = list(range(lb + 1))
    for i in range(1, la + 1):
        prev = dp[0]; dp[0] = i
        for j in range(1, lb + 1):
            temp = dp[j]
            dp[j] = prev if a[i-1] == b[j-1] else 1 + min(prev, dp[j], dp[j-1])
            prev = temp
    return dp[lb]

def is_similar_to_read(text: str) -> bool:
    threshold = max(2, len(text) // 5)
    for read in read_texts:
        if edit_distance(text, read) <= threshold:
            return True
    return False

def is_new(text: str) -> bool:
    if text in read_texts:
        return False
    if is_similar_to_read(text):
        return False
    read_texts.add(text)
    return True

def process_frame(base64_data: str):
    global visible_texts
    if not EASYOCR_OK or ocr_reader is None or not running:
        return
    try:
        img_bytes = base64.b64decode(base64_data)
        np_arr    = np.frombuffer(img_bytes, np.uint8)
        frame     = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            return
        results = ocr_reader.readtext(frame)
    except Exception as e:
        send_status('warn', f'OCR失敗: {e}')
        return

    candidates = []
    for (bbox, text, conf) in results:
        if conf < 0.45:
            continue
        cleaned = clean_text(text)
        if not cleaned or len(cleaned) < 2:
            continue
        if _RE_NOISE.match(cleaned):
            continue
        if _RE_EMOJI_MISREAD.match(cleaned):
            continue
        top_y = bbox[0][1]
        candidates.append((top_y, cleaned))

    candidates.sort(key=lambda x: x[0])
    current_texts = set(c for _, c in candidates)

    for top_y, cleaned in candidates:
        if cleaned in visible_texts:
            continue
        if not is_new(cleaned):
            continue
        kind = classify_comment(cleaned)
        send_comment(cleaned, kind)
        enqueue_tts(cleaned)

    visible_texts = current_texts

def ocr_worker():
    """OCR専用スレッド：常に最新フレームを直列処理"""
    while True:
        frame_event.wait()
        frame_event.clear()
        with frame_lock:
            data = pending_frame[0]
            pending_frame[0] = None
        if data and running:
            process_frame(data)

def enqueue_tts(text: str):
    with tts_lock:
        tts_queue.append(text)

def tts_loop():
    while True:
        text = None
        with tts_lock:
            if tts_queue:
                text = tts_queue.popleft()
        if text:
            speed_pct = config.get('speed', 100)
            send({'type': 'tts-start', 'text': text})
            speak(text, speed_pct)
            send({'type': 'tts-end', 'text': text})
        time.sleep(0.05)

def main():
    global running, config, visible_texts, read_texts

    send_status('ready')
    init_ocr()
    init_tts()

    threading.Thread(target=tts_loop, daemon=True).start()
    threading.Thread(target=ocr_worker, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue

        action = cmd.get('action')

        if action == 'start':
            config        = cmd
            running       = True
            read_texts    = set()
            visible_texts = set()
            send_status('running')

        elif action == 'frame':
            if running:
                with frame_lock:
                    pending_frame[0] = cmd.get('data', '')
                frame_event.set()

        elif action == 'stop':
            running       = False
            visible_texts = set()
            send_status('stopped')

        elif action == 'resume':
            running = True
            send_status('running')

        elif action == 'update-speed':
            config['speed'] = cmd.get('speed', 100)

        elif action == 'quit':
            running = False
            break

if __name__ == '__main__':
    main()