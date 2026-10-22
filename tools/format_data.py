"""Rewrite data.json in the canonical format (2-space JSON), like `node tools/check-data.js --fix`.

Use it after editing data.json by hand when Node is not installed. Run from the repository root:
    py tools/format_data.py        (Windows)
    python3 tools/format_data.py   (macOS, Linux)
"""
import json
import pathlib
import sys

path = pathlib.Path(__file__).resolve().parent.parent / 'data.json'
text = path.read_bytes().decode('utf-8')
try:
    data = json.loads(text)
except json.JSONDecodeError as e:
    sys.exit(f'data.json is not valid JSON: {e}')
# same output as JSON.stringify(data, null, 2) + "\n" in core.js
canonical = json.dumps(data, indent=2, ensure_ascii=False) + '\n'
if canonical == text:
    print('data.json is already in the canonical format')
else:
    path.write_bytes(canonical.encode('utf-8'))
    print('data.json reformatted')
