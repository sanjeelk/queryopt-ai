"""QueryOpt AI API for Olist-backed PostgreSQL plan measurements."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .dataset import (
    BENCHMARK_QUERIES,
    benchmark_seeded_queries,
    business_preview,
    dataset_metadata,
)
from .db import engine, query_measurements
from .ingest import import_olist_files
from .optimizer import (
    analyze_query,
    dataset_rows,
    model_comparison,
    model_status,
    recent_measurements,
    run_candidates,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    from .db import initialize_schema

    initialize_schema()
    yield
    engine.dispose()


app = FastAPI(
    title="QueryOpt AI API",
    description="PostgreSQL query telemetry and ML-assisted plan comparison using the uploaded Olist dataset.",
    version="1.1.0",
    lifespan=lifespan,
)

origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=r"https://[a-zA-Z0-9-]+\.vercel\.app",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class AnalyzeRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=4_000)


@app.get("/health")
def health():
    with engine.connect() as connection:
        connection.exec_driver_sql("SELECT 1")
    return {"status": "ok", "database": "postgresql", "service": "queryopt-api"}


@app.get("/api/overview")
def overview():
    with engine.connect() as connection:
        total = int(
            connection.execute(
                select(func.count()).select_from(query_measurements)
            ).scalar_one()
        )
        live = int(
            connection.execute(
                select(func.count())
                .select_from(query_measurements)
                .where(query_measurements.c.is_benchmark.is_(False))
            ).scalar_one()
        )
        average_ms = connection.execute(
            select(func.avg(query_measurements.c.execution_ms))
        ).scalar_one()
        latest = connection.execute(
            select(func.max(query_measurements.c.created_at))
        ).scalar_one()
    dataset = dataset_metadata()
    return {
        "database": "PostgreSQL",
        "data_mode": "live_measurements" if dataset["dataset_loaded"] else "awaiting_dataset_upload",
        "measurements": {"total": total, "benchmark": total - live, "live": live},
        "average_execution_ms": round(float(average_ms), 3) if average_ms is not None else None,
        "latest_measurement_at": latest.isoformat() if latest else None,
        "model": model_status(),
        "dataset": dataset,
    }


@app.get("/api/dataset")
def get_dataset(limit: int = Query(default=100, ge=1, le=500)):
    info = dataset_metadata()
    return {
        **info,
        "feature_count": 14,
        "target_variable": "Measured PostgreSQL execution time (milliseconds)",
        "business_preview": business_preview() if info["dataset_loaded"] else [],
        "items": dataset_rows(limit),
        "notes": (
            "Business rows come from the uploaded Olist CSV files. Query plans, costs, "
            "buffers, and execution times are collected from PostgreSQL at runtime."
            if info["dataset_loaded"]
            else "No business rows or benchmark results are preloaded. Upload the four Olist CSV files to begin."
        ),
    }


@app.post("/api/dataset/upload")
def upload_dataset(files: list[UploadFile] = File(...)):
    try:
        imported = import_olist_files(files)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        benchmark_records = benchmark_seeded_queries(run_candidates)
    except Exception:
        logging.exception("The Olist dataset was imported, but initial SQL benchmarks did not finish.")
        benchmark_records = 0

    return {
        "message": "Olist dataset imported successfully.",
        "dataset": dataset_metadata(),
        "uploaded_table_sizes": imported["table_sizes"],
        "benchmark_measurements_added": benchmark_records,
    }


@app.get("/api/models")
def models():
    return model_comparison()


@app.get("/api/query-history")
def query_history(limit: int = Query(default=25, ge=1, le=100)):
    items = recent_measurements(limit)
    return {"items": items, "count": len(items)}


@app.post("/api/optimize")
def optimize(body: AnalyzeRequest):
    if not dataset_metadata()["dataset_loaded"]:
        raise HTTPException(
            status_code=409,
            detail="Upload the Olist dataset from the Dataset page before optimizing queries.",
        )
    try:
        return analyze_query(body.sql)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/examples")
def examples():
    return {
        "items": [
            {"id": f"query-{index + 1}", "sql": sql}
            for index, sql in enumerate(BENCHMARK_QUERIES)
        ]
    }


