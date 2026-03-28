"""FastAPI application for the Anna's Archive web dashboard.

Provides a RESTful API wrapping the existing CLI functionality:
search, downloads, history, settings, and diagnostics.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .dependencies import require_api_key
from .download_manager import DownloadManager
from .routes import (
    diagnostics,
    downloads,
    history,
    search,
    settings,
)

from src.config_manager import get_config

logger = logging.getLogger("annas_archive")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application startup and shutdown lifecycle.

    On startup: initialize the DownloadManager and store on app.state.
    On shutdown: gracefully shut down the DownloadManager.
    """
    config = get_config()
    manager = DownloadManager(config)
    manager.start()
    app.state.download_manager = manager
    logger.info("API server started")

    yield

    manager.shutdown()
    logger.info("API server shut down")


app = FastAPI(
    title="Anna's Archive Dashboard API",
    description="Backend API for the Anna's Archive web dashboard",
    version="1.0.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS -- allow the Next.js dev server on localhost:3000
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["X-API-Key", "Content-Type", "Accept"],
)

# ---------------------------------------------------------------------------
# Register all route modules under /api prefix with API key auth
# ---------------------------------------------------------------------------
_auth = [Depends(require_api_key)]

app.include_router(search.router, prefix="/api", dependencies=_auth)
app.include_router(downloads.router, prefix="/api", dependencies=_auth)
app.include_router(history.router, prefix="/api", dependencies=_auth)
app.include_router(settings.router, prefix="/api", dependencies=_auth)
app.include_router(diagnostics.router, prefix="/api", dependencies=_auth)


@app.get("/api/health")
def health_check() -> dict:
    """Simple health check endpoint."""
    return {"status": "ok"}
