#!/usr/bin/env python3
"""Compatibility launcher. FastAPI is the only application/model owner."""
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.api.app:app", host="127.0.0.1", port=8000, workers=1)
