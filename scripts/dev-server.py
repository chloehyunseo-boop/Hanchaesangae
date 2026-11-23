#!/usr/bin/env python3
"""로컬 미리보기용 정적 서버 — python3 -m http.server의 문제(캐시 헤더를 안 보내서
브라우저가 고친 파일을 계속 옛날 버전으로 쓰는 문제, 2026-11-22 발견)를 고친 버전.
사용법: python3 scripts/dev-server.py [포트, 기본 8787]
"""
import http.server
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


http.server.test(HandlerClass=NoCacheHandler, port=port)
