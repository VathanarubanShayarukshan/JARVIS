FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY webui ./webui

ENV DATA_DIR=/data
RUN mkdir -p /data/workspace

EXPOSE 8000
CMD ["python", "-m", "app.main"]