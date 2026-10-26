"""Runs a command in a pseudo-terminal of a fixed size and relays it over stdio.

    python3 -I run-in-pty.py <cols> <rows> -- <command> [args...]

Bytes on stdin go to the terminal as typed input; the terminal's output goes
to stdout. The media stage server uses it so pi sees a real terminal.
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
command = sys.argv[sys.argv.index("--") + 1 :]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
while True:
    ready, _, _ = select.select([fd, stdin], [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(stdout, data)
    if stdin in ready:
        data = os.read(stdin, 65536)
        if not data:
            break
        os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
