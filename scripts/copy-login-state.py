"""Copy only Notion-domain login cookies and encrypted key state, locally.

Requires explicit user authorization. Never decrypts or prints cookie/key values.
The source SQLite connection is read-only. Only filtered rows enter the copy.
"""
import argparse
import json
import os
import pathlib
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('--authorized', action='store_true')
args = parser.parse_args()
if not args.authorized:
    raise SystemExit('Explicit authorization to copy login state is required')

project = pathlib.Path(__file__).resolve().parents[1]
root = project / '.notion-switch'
source = pathlib.Path(os.environ['APPDATA']) / 'Notion'
target = root / 'profile'
if not (root / 'prepared.json').exists():
    raise SystemExit('Prepare the isolated prototype first')
if target == source or source in target.parents:
    raise SystemExit('Destination must be isolated')

state_file = source / 'Local State'
source_state = json.loads(state_file.read_text(encoding='utf-8'))
if 'os_crypt' not in source_state:
    raise SystemExit('This installation uses an unsupported encryption key layout')
target.mkdir(parents=True, exist_ok=True)
target_state_file = target / 'Local State'
target_state = json.loads(target_state_file.read_text(encoding='utf-8')) if target_state_file.exists() else {}
counts = []
for relative in [pathlib.Path('Partitions/notion/Network/Cookies'), pathlib.Path('Network/Cookies')]:
    source_db, target_db = source / relative, target / relative
    if not source_db.exists():
        continue
    target_db.parent.mkdir(parents=True, exist_ok=True)
    source_connection = sqlite3.connect(source_db.as_uri() + '?mode=ro', uri=True, timeout=5)
    filtered_db = target_db.with_name('Cookies.filtered')
    filtered_db.unlink(missing_ok=True)
    target_connection = sqlite3.connect(str(filtered_db))
    try:
        # Copy schema and database version metadata, never unfiltered cookie rows.
        for (schema,) in source_connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('meta','cookies')"):
            target_connection.execute(schema)
        target_connection.executemany('INSERT INTO meta VALUES (?,?)', source_connection.execute('SELECT * FROM meta'))
        rows = source_connection.execute("""SELECT * FROM cookies WHERE (
          host_key IN ('notion.so', '.notion.so', 'notion.com', '.notion.com')
          OR host_key LIKE '%.notion.so' OR host_key LIKE '%.notion.com'
        )""")
        placeholders = ','.join('?' for _ in rows.description)
        target_connection.executemany('INSERT INTO cookies VALUES (' + placeholders + ')', rows)
        target_connection.commit()
        count = target_connection.execute('SELECT count(*) FROM cookies').fetchone()[0]
        counts.append({'partition': str(relative), 'notionCookieCount': count})
    finally:
        source_connection.close()
        target_connection.close()
    for suffix in ('-wal', '-shm', '-journal'):
        target_db.with_name(target_db.name + suffix).unlink(missing_ok=True)
    filtered_db.replace(target_db)

target_state['os_crypt'] = source_state['os_crypt']
target_state_file.write_text(json.dumps(target_state), encoding='utf-8')

result = {'copied': True, 'onlyNotionDomains': True, 'decrypted': False, 'pageDatabasesCopied': False, 'sourceOpenedReadOnly': True, 'partitions': counts}
(root / 'login-copy-result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
