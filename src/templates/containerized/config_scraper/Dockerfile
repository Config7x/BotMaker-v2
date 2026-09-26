FROM python:3.11-slim

# BotMaker v2 containerized template #11 — Config Auto-Scraper & Poster
# Pre-built, code-reviewed source (see ../source). No user-uploaded code.

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY source/ /app/

# platform integration shims (env-driven session login service)
COPY shims/ /app/shims/

ENV PYTHONUNBUFFERED=1

# default: management bot; scraper runs via the same entry with arg "scraper"
CMD ["python3", "bot.py"]
