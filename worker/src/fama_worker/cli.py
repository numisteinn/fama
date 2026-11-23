"""`fama make`, `fama voices`, `fama work`."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from pathlib import Path

from fama_worker.model import FileSource, Source, TextSource, UrlSource, VoiceRef


def _source(value: str) -> Source:
    if value == "-":
        return TextSource(None, sys.stdin.read())
    if value.startswith(("http://", "https://")):
        return UrlSource(value)
    path = Path(value)
    if not path.exists():
        raise SystemExit(f"No such file: {value}")
    return FileSource(path)


class _Printer:
    def __init__(self) -> None:
        self.last = 0.0

    def stage(self, stage: str, done: int, total: int) -> None:
        now = time.monotonic()
        if done in (0, total) or now - self.last > 2:
            self.last = now
            print(f"  {stage} {done}/{total}", file=sys.stderr)

    def chapter_ready(self, chapter) -> None:
        print(f"  chapter {chapter.index:03d} {chapter.duration_ms / 1000:.0f}s  {chapter.title}", file=sys.stderr)


def make(args: argparse.Namespace) -> None:
    from fama_worker.engines import default_voice
    from fama_worker.extract import extract
    from fama_worker.pipeline import narrate

    started = time.monotonic()
    document = extract(_source(args.source), args.language)
    voice = VoiceRef.parse(args.voice) if args.voice else default_voice(document.language)
    words = sum(len(c.text.split()) for c in document.chapters)
    print(f"{document.title} | {document.author or '-'} | {document.language} | {len(document.chapters)} chapters, "
          f"{words} words | {voice}", file=sys.stderr)
    book = narrate(document, voice, args.speed, Path(args.out), reporter=_Printer())
    elapsed = time.monotonic() - started
    print(f"{book.path}  {book.duration_ms / 1000:.0f}s audio in {elapsed:.0f}s", file=sys.stderr)


def voices(args: argparse.Namespace) -> None:
    from fama_worker.engines import DEFAULT_VOICE, all_voices

    defaults = {str(v): language for language, v in DEFAULT_VOICE.items()}
    listed = all_voices()
    if args.json:
        print(json.dumps([v.to_json() for v in listed], ensure_ascii=False, indent=2))
        return
    for voice in listed:
        mark = f"  default for {defaults[str(voice.ref)]}" if str(voice.ref) in defaults else ""
        print(f"{str(voice.ref):28} {voice.language:3} {voice.gender or '-':7} {voice.name}{mark}")


def work(args: argparse.Namespace) -> None:
    from fama_worker.work import run

    run(args.api, args.token, args.worker_id or socket.gethostname(), out_dir=Path(args.out), once=args.once,
        drain=args.drain)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="fama", description="Turn links, files and text into narrated audio.")
    commands = parser.add_subparsers(required=True)

    p = commands.add_parser("make", help="narrate one source into chapter files and a book file")
    p.add_argument("source", help="URL, file path (PDF, EPUB, TXT, MD, HTML), or - for text on stdin")
    p.add_argument("--voice", help="engine:voiceId, for example kokoro:af_heart. Default: by language")
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--language", help="ISO 639-1 code. Default: detected")
    p.add_argument("--out", default="out")
    p.set_defaults(run=make)

    p = commands.add_parser("voices", help="list voices of all engines")
    p.add_argument("--json", action="store_true")
    p.set_defaults(run=voices)

    p = commands.add_parser("work", help="pull jobs from the Fama API and process them")
    p.add_argument("--api", required=True, help="API origin, for example http://localhost:8787")
    p.add_argument("--token", required=True)
    p.add_argument("--worker-id")
    p.add_argument("--out", default=str(Path.home() / ".cache" / "fama" / "work"))
    stop_when = p.add_mutually_exclusive_group()
    stop_when.add_argument("--once", action="store_true", help="stop after one job, or when the queue is empty")
    stop_when.add_argument("--drain", action="store_true", help="take jobs until the queue is empty, then stop")
    p.set_defaults(run=work)

    args = parser.parse_args(argv)
    args.run(args)
