# Transport adapter only. The inference service is provisioned separately.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir httpx==0.28.1 runpod==1.8.1
COPY handler.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "handler.py"]
