"""One command, one subreaper. No background jobs survive a successful receipt.

stdin accepts a single 'stop' line. The native process itself is never signaled by
JS: native kill/AbortSignal would only kill this supervisor, not its descendants.
"""
import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time
import threading

spec = json.loads(sys.argv[1])
receipt = spec['receipt']
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise RuntimeError('subreaper unavailable')
stopping = False
reason = None

def stop(_sig=None, _frame=None):
    global stopping, reason
    stopping = True
    reason = reason or 'aborted'

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

# A session owns normal children; subreaping also catches double forks/setsid.
def descendants():
    parents = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                fields = open('/proc/' + name + '/stat').read().rsplit(')', 1)[1].split()
                parents[int(name)] = int(fields[1])
            except (FileNotFoundError, ProcessLookupError):
                pass
    owned = {os.getpid()}
    while True:
        found = {pid for pid, parent in parents.items() if parent in owned}
        if found <= owned:
            return owned - {os.getpid()}
        owned |= found

def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return False
        except ChildProcessError:
            return True

def signal_tree(sig):
    for pid in descendants():
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

lock = threading.Lock()
output_bytes = 0
output_lines = 0
buffered = []
spill = None
pump_failed = False

def pump_body(source, destination):
    global output_bytes, output_lines, spill, reason, stopping
    while True:
        data = os.read(source.fileno(), 16384)
        if not data:
            return
        with lock:
            output_bytes += len(data)
            output_lines += data.count(b'\n')
            if output_bytes > spec['maxOutputBytes']:
                reason = 'output_limit'
                stopping = True
                continue
            thresholds = spec.get('spill')
            if thresholds:
                if spill is None:
                    buffered.append(data)
                    if output_bytes > thresholds['afterBytes'] or output_lines > thresholds['afterLines']:
                        spill = open(receipt + '.output', 'xb')
                        for chunk in buffered:
                            spill.write(chunk)
                        buffered.clear()
                else:
                    spill.write(data)
            destination.buffer.write(data)
            destination.buffer.flush()

def pump(source, destination):
    global pump_failed, stopping
    try:
        pump_body(source, destination)
    except BaseException:
        pump_failed = True
        stopping = True

started = time.monotonic()
code = None
try:
    child = subprocess.Popen(spec['argv'], cwd=spec['cwd'], env=spec['env'], start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
except OSError as error:
    reason = 'spawn_error'
    detail = str(error)
    child = None
else:
    detail = ''
    pumps = [threading.Thread(target=pump, args=(child.stdout, sys.stdout)), threading.Thread(target=pump, args=(child.stderr, sys.stderr))]
    for thread in pumps:
        thread.start()
    while True:
        code = child.poll()
        if code is not None or stopping:
            break
        if time.monotonic() - started >= spec['timeout']:
            reason = 'timeout'
            break
        ready, _, _ = select.select([sys.stdin], [], [], 0.02)
        if ready:
            sys.stdin.readline()  # EOF also means the owner disappeared.
            stop()

# Kill survivors even after an otherwise normal shell exit.
signal_tree(signal.SIGTERM)
grace = time.monotonic() + 0.25
while time.monotonic() < grace and descendants():
    if child:
        child.poll()
    reap()
    time.sleep(0.01)
end = time.monotonic() + 2
while descendants() or not reap():
    signal_tree(signal.SIGKILL)
    if child:
        child.poll()
    reap()
    if time.monotonic() > end:
        raise RuntimeError('descendants did not quiesce')
    time.sleep(0.01)
if child:
    child.wait()
    for thread in pumps:
        thread.join(timeout=2)
        if thread.is_alive():
            raise RuntimeError('output stream did not quiesce')
if pump_failed:
    raise RuntimeError('output pump failed')
if spill:
    spill.close()
# No receipt on an uncertain exit; the Worker must destroy/fence the instance.
with open(receipt, 'x') as out:
    json.dump({'exitCode': code if code is not None else -1, 'error': reason, 'detail': detail, 'spillPath': receipt + '.output' if spill else None}, out)
