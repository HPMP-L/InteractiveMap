"""Copy the shared validation code (core.js) into the worker, so both always apply suggestions the same way.

Run from the repository root after editing core.js:
    python tools/sync_core.py
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
core = (root / 'core.js').read_text(encoding='utf-8')
worker_path = root / 'worker' / 'worker.js'
worker = worker_path.read_text(encoding='utf-8')

pattern = re.compile(r'// ==== CORE BEGIN ====.*?// ==== CORE END ====', re.S)
block = pattern.search(core)
if not block or not pattern.search(worker):
    sys.exit('CORE markers not found in core.js or worker/worker.js')
new_worker = pattern.sub(lambda _: block.group(0), worker, count=1)
if new_worker == worker:
    print('worker/worker.js already up to date')
else:
    worker_path.write_text(new_worker, encoding='utf-8', newline='\n')
    print('worker/worker.js updated from core.js')
