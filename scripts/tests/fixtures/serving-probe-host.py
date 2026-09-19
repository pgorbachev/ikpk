"""Test-only boundary stubs: execute the real uploaded program, never emulate its protocol."""
import io
import json
import shlex
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from email.message import Message

with open(sys.argv[1], encoding="utf-8") as stream:
    fixture = json.load(stream)

def log(entry):
    with open(fixture["log"], "a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry) + "\n")

def run(argv, **kwargs):
    log({"kind": "command", "argv": argv, "shell": kwargs.get("shell", False)})
    if argv != ["/usr/bin/sudo", "-n", "/usr/sbin/nginx", "-T"] or kwargs.get("shell"):
        raise AssertionError("test refuses unexpected privileged command")
    code = 1 if fixture.get("nginxFailure") else 0
    stdout = fixture["nginxDump"]
    stderr = "fixture nginx inspection failed" if code else "nginx: configuration file test is successful\n"
    if not kwargs.get("text") and not kwargs.get("encoding"):
        stdout, stderr = stdout.encode(), stderr.encode()
    result = subprocess.CompletedProcess(argv, code, stdout, stderr)
    if kwargs.get("check") and code:
        raise subprocess.CalledProcessError(code, argv, stdout, stderr)
    return result

class Response(io.BytesIO):
    def __init__(self):
        body = fixture.get("readyBody", {"status": "ready", "mode": "test", "shopId": "shop-42"})
        super().__init__((body if isinstance(body, str) else json.dumps(body)).encode())
        self.status = fixture.get("readyStatus", 200)
        self.code = self.status
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"
        if self.status == 302:
            self.headers["Location"] = "https://forbidden.test.invalid/readyz"
    def getcode(self):
        return self.status
    def geturl(self):
        return "http://127.0.0.1:8787/readyz"
    def info(self):
        return self.headers

def urlopen(request, *args, **kwargs):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    method = request.get_method() if isinstance(request, urllib.request.Request) else "GET"
    log({"kind": "http", "url": url, "method": method})
    if url != "http://127.0.0.1:8787/readyz" or method != "GET":
        raise AssertionError("test refuses a non-loopback readiness request")
    if fixture.get("networkFailure"):
        raise urllib.error.URLError("fixture service unavailable")
    return Response()

def deny_process(*args, **kwargs):
    raise AssertionError("test refuses unhandled subprocess execution")

def deny_socket(*args, **kwargs):
    raise AssertionError("test refuses real network")

subprocess.run = run
subprocess.Popen = deny_process
urllib.request.urlopen = urlopen
urllib.request.OpenerDirector.open = lambda self, *args, **kwargs: urlopen(*args, **kwargs)
socket.create_connection = deny_socket
parts = shlex.split(sys.argv[2])
if parts[:4] != ["python3", "-I", "-u", "-c"] or len(parts) != 7:
    raise AssertionError("unexpected SSH program")
log({"kind": "connection"})
sys.argv = ["<remote>", *parts[5:]]
exec(compile(parts[4], "<publication-remote>", "exec"), {"__name__": "__main__"})
