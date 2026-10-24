"""Drive the built dsh tui profile over a Unix PTY with isolated persisted history."""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>]')


def replay(node, cli, fixture, expected, frames):
    with tempfile.TemporaryDirectory(prefix='dsh-tui-snapshot-') as temporary:
        root = Path(temporary).resolve()
        cwd = root / 'project'
        home = root / 'home'
        dsh = home / '.dsh'
        cwd.mkdir()
        home.mkdir()
        session_id = 'tui-recorded-session'
        project_key = '--' + str(cwd).replace('/', '-').lstrip('-')[:251] + '--'
        session_dir = dsh / 'sessions' / project_key / session_id
        session_dir.mkdir(parents=True)
        profile = dsh / 'profiles' / 'web'
        profile.mkdir(parents=True)
        (profile / 'cordis.patch.yml').write_text(json.dumps([
            {'id': 'session-persistence-jsonl', 'config': {'root': str(dsh / 'sessions'), 'compression': 'none'}},
        ]))
        source = Path(fixture).read_text()
        materialized = source.replace('{{cwd}}', str(cwd)).replace('{{session:1}}', session_id)
        materialized = re.sub(r'\{\{([^{}]+)\}\}', lambda match: 'snapshot-' + match[1].replace(':', '-'), materialized)
        rows = [json.loads(line) for line in materialized.splitlines()]
        for sequence, row in enumerate(rows[1:]):
            row.update(seq=sequence, time=rows[0]['createdAt'] + sequence)
        materialized = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows)
        persisted = session_dir / Path(fixture).name
        persisted.write_text(materialized)
        assistant, text, ready = Path(expected).read_text().splitlines()
        rendered = re.compile(r'(?:^|\n)' + re.escape(assistant) + r'\s*\r?\n\s*' + re.escape(text) + r'\s*(?:\r?\n|$)')
        environment = {
            'PATH': str(Path(node).parent) + os.pathsep + os.environ.get('PATH', ''),
            'HOME': str(home), 'DSH_HOME': str(dsh), 'DSH_AGENTS_HOME': str(root / 'agents'),
            'DSH_TELEMETRY_DISABLED': '1', 'TERM': 'xterm-256color',
            'TERM_PROGRAM': 'Apple_Terminal', 'LANG': 'en_US.UTF-8',
        }
        master, slave = pty.openpty()
        process = None
        raw = bytearray()

        def pump():
            if select.select([master], [], [], 0.1)[0]:
                try:
                    raw.extend(os.read(master, 65536))
                except OSError as error:
                    if process.poll() is None:
                        raise error

        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
            process = subprocess.Popen([node, cli, 'tui', '--resume', session_id], cwd=cwd,
                                       env=environment, stdin=slave, stdout=slave, stderr=slave,
                                       start_new_session=True)
            os.close(slave)
            slave = None
            deadline = time.monotonic() + 70
            while time.monotonic() < deadline:
                pump()
                terminal = ANSI.sub('', raw.decode('utf-8', 'replace'))
                if rendered.search(terminal) and re.search(r'(?:^|\n)\s*Connected · ' + re.escape(ready) + r' · Queue \(0\)', terminal):
                    break
                if process.poll() is not None:
                    raise AssertionError(f'Terminal exited {process.returncode} before replay was visible')
            else:
                raise AssertionError('Terminal did not display the expected assistant reply and readiness')
            frame_dir = Path(frames)
            (frame_dir / 'chat.ansi').write_bytes(raw)
            mark = len(raw)
            os.write(master, b'\x1b[200~/model\x1b[201~\r')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                pump()
                if 'Select a model' in ANSI.sub('', raw[mark:].decode('utf-8', 'replace')):
                    break
            else:
                raise AssertionError('Recorded Session model menu did not open')
            for _ in range(3):
                pump()
            (frame_dir / 'menu.ansi').write_bytes(raw)
            mark = len(raw)
            os.write(master, b'\x1b')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                pump()
                if 'Connected · ' + ready in ANSI.sub('', raw[mark:].decode('utf-8', 'replace')):
                    break
            else:
                raise AssertionError('Escape did not restore the recorded conversation')
            (frame_dir / 'restored.ansi').write_bytes(raw)
            os.write(master, b'\x03')
            deadline = time.monotonic() + 15
            while process.poll() is None and time.monotonic() < deadline:
                pump()
            assert process.poll() == 0, f'Terminal failed to exit cleanly: {process.poll()}'
            actual = [json.loads(line) for line in persisted.read_text().splitlines()]
            assert actual[:len(rows)] == rows, 'Resuming rewrote recorded Session history'
            appended = actual[len(rows):]
            assert all(row['type'] in {'session/end-seed', 'agent/inbox/spliced'}
                       for row in appended), 'Resuming started unexpected work'
            assert all(row['data'] == {} for row in appended if row['type'] == 'session/end-seed')
            inbox = [row['data'] for row in appended if row['type'] == 'agent/inbox/spliced']
            if inbox:
                assert len(inbox) == 2, 'Resuming left unexpected inbox work'
                inserted, canceled = inbox
                assert inserted['target'] == 'next-step' and inserted['start'] == 0
                assert inserted.get('removedCount', 0) == 0 and len(inserted['inserted']) == 1
                hook = inserted['inserted'][0]
                assert hook['source'] == {'kind': 'hooks-claude-code'}, 'Resuming queued an unexpected prompt'
                assert all(part['type'] == 'text' for part in hook['content'])
                assert canceled == {'target': 'next-step', 'start': 0, 'removedCount': 1,
                                    'inserted': [], 'outcome': 'canceled'}, 'Resuming left pending inbox work'
        except BaseException:
            sys.stderr.write(ANSI.sub('', raw.decode('utf-8', 'replace')) + '\n')
            raise
        finally:
            if slave is not None:
                os.close(slave)
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            os.close(master)


if __name__ == '__main__':
    replay(*sys.argv[1:])
    print('Recorded terminal Session replay passed')
