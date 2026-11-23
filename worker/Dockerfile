# Fama worker in Docker, for a server you run yourself.
#
#   docker build -t fama-worker worker
#   docker run -d --restart unless-stopped -v fama-cache:/cache fama-worker \
#     --api https://fama.example.com --token "$FAMA_WORKER_TOKEN"
#
# Add `--gpus all` on a Linux host with an NVIDIA GPU. Without it, the worker runs on the CPU.
# Model weights download on the first job of each voice and stay in the /cache volume.
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.11 /uv /uvx /bin/

# ffmpeg encodes chapters and assembles the book. espeak-ng ships inside piper-tts and espeakng-loader.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PROJECT_ENVIRONMENT=/usr/local \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUTF8=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/cache/hf \
    FTLANG_CACHE=/cache/fasttext \
    FAMA_CACHE_DIR=/cache/chunks

WORKDIR /app

# Dependencies first, so a code change does not reinstall torch.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --inexact --no-dev --no-install-project

COPY README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --inexact --no-dev --no-editable

VOLUME /cache
ENTRYPOINT ["fama", "work", "--out", "/cache/work"]
