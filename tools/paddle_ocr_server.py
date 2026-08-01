"""Small localhost-only bridge from the Obsidian plugin to PP-OCRv5 mobile."""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from typing import Any

import numpy as np
from PIL import Image
from paddleocr import PaddleOCR


HOST = "127.0.0.1"
PORT = 7861


def create_ocr() -> PaddleOCR:
    # CPU is deliberate: the text-analysis model can keep using the GPU.
    return PaddleOCR(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )


OCR = create_ocr()


def restart_process() -> None:
    time.sleep(0.25)
    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])


def recognize(image_base64: str) -> list[dict[str, Any]]:
    image_bytes = base64.b64decode(image_base64, validate=True)
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    result = next(iter(OCR.predict(np.asarray(image))))
    payload = result.json.get("res", {})
    texts = payload.get("rec_texts", [])
    scores = payload.get("rec_scores", [])
    return [
        {"text": str(text), "score": float(scores[index]) if index < len(scores) else None}
        for index, text in enumerate(texts)
        if str(text).strip()
    ]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        print(format % args, flush=True)

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok", "engine": "PP-OCRv5_mobile"})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.rstrip("/") == "/restart":
            self.send_json(HTTPStatus.ACCEPTED, {"status": "restarting"})
            threading.Thread(target=restart_process, daemon=True).start()
            return
        if self.path.rstrip("/") != "/ocr":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            lines = recognize(str(payload.get("imageBase64", "")))
            self.send_json(
                HTTPStatus.OK,
                {"text": "\n".join(line["text"] for line in lines), "lines": lines},
            )
        except Exception as error:  # Return a useful plugin error without crashing the service.
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"PP-OCRv5: {error}"})


if __name__ == "__main__":
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    print(f"PP-OCRv5 mobile listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
