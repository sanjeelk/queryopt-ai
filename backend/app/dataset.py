"""Olist dataset provenance and live PostgreSQL measurement helpers."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError

from .db import (
    app_meta,
    customers,
    engine,
    geolocation,
    order_items,
    order_payments,
    order_reviews,
    orders,
    products,
    product_category_name_translation,
    query_measurements,
    sellers,
)

DATASET_NAME = "Brazilian E-Commerce Public Dataset by Olist"
DATASET_URL = "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce"
DATASET_LICENSE = "CC BY-NC-SA 4.0"
BENCHMARK_VERSION = "olist-v2-all-tables"

# Five query shapes are measured on the uploaded Olist tables. These are SQL
# workloads, not fabricated measurement rows or pre-set performance labels.
BENCHMARK_QUERIES = [
    "SELECT order_status, COUNT(*) AS order_count FROM orders GROUP BY order_status ORDER BY order_count DESC",
    "SELECT p.product_category_name, SUM(i.price + i.freight_value) AS gross_value FROM order_items i JOIN products p ON p.product_id = i.product_id GROUP BY p.product_category_name ORDER BY gross_value DESC LIMIT 20",
    "SELECT c.customer_state, COUNT(DISTINCT o.order_id) AS order_count, SUM(i.price + i.freight_value) AS gross_value FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_items i ON i.order_id = o.order_id GROUP BY c.customer_state ORDER BY gross_value DESC",
    "SELECT order_id, customer_id, order_purchase_timestamp, order_status FROM orders WHERE order_status = 'delivered' ORDER BY order_purchase_timestamp DESC LIMIT 100",
    "SELECT p.product_category_name, o.order_status, COUNT(*) AS item_count, AVG(i.price) AS average_price FROM order_items i JOIN products p ON p.product_id = i.product_id JOIN orders o ON o.order_id = i.order_id GROUP BY p.product_category_name, o.order_status ORDER BY item_count DESC LIMIT 100",
    "SELECT payment_type, COUNT(*) AS payment_count, ROUND(AVG(payment_value)::numeric, 2) AS average_payment FROM order_payments GROUP BY payment_type ORDER BY payment_count DESC",
    "SELECT r.review_score, COUNT(*) AS review_count, ROUND(AVG(p.payment_value)::numeric, 2) AS average_payment FROM order_reviews r JOIN order_payments p ON p.order_id = r.order_id GROUP BY r.review_score ORDER BY r.review_score",
    "SELECT s.seller_state, COUNT(*) AS item_count, ROUND(SUM(i.price)::numeric, 2) AS sales FROM sellers s JOIN order_items i ON i.seller_id = s.seller_id GROUP BY s.seller_state ORDER BY sales DESC LIMIT 20",
    "SELECT t.product_category_name_english, COUNT(*) AS products FROM product_category_name_translation t JOIN products p ON p.product_category_name = t.product_category_name GROUP BY t.product_category_name_english ORDER BY products DESC LIMIT 20",
    "SELECT c.customer_state, COUNT(DISTINCT c.customer_id) AS customers, COUNT(g.geolocation_id) AS location_points FROM customers c JOIN geolocation g ON g.geolocation_zip_code_prefix = c.customer_zip_code_prefix GROUP BY c.customer_state ORDER BY location_points DESC LIMIT 10",
]


def _table_count(connection, table) -> int:
    return int(connection.execute(select(func.count()).select_from(table)).scalar_one())


def benchmark_seeded_queries(run_candidates) -> int:
    """Measure the starter SQL workload once after real Olist rows are uploaded."""
    with engine.connect() as connection:
        if _table_count(connection, customers) == 0:
            return 0
        already_seeded = connection.execute(
            select(app_meta.c.value).where(app_meta.c.key == "benchmark_version")
        ).scalar_one_or_none()
    if already_seeded == BENCHMARK_VERSION:
        return 0

    recorded = 0
    for query in BENCHMARK_QUERIES:
        try:
            recorded += run_candidates(query, is_benchmark=True)
        except (DBAPIError, ValueError):
            # A benchmark can exceed the configured query timeout on a small
            # hosting tier. Keep its real successful measurements and continue.
            continue

    with engine.begin() as connection:
        connection.execute(
            pg_insert(app_meta)
            .values(key="benchmark_version", value=BENCHMARK_VERSION)
            .on_conflict_do_update(
                index_elements=[app_meta.c.key],
                set_={"value": BENCHMARK_VERSION},
            )
        )
    return recorded


def table_sizes() -> dict[str, int]:
    with engine.connect() as connection:
        return {
            table.name: _table_count(connection, table)
            for table in (
                customers, products, orders, order_items, order_payments,
                order_reviews, sellers, product_category_name_translation,
                geolocation,
            )
        }


def business_preview(limit: int = 12) -> list[dict]:
    with engine.connect() as connection:
        rows = connection.execute(
            select(
                orders.c.order_id,
                orders.c.customer_id,
                orders.c.order_status,
                orders.c.order_purchase_timestamp,
                orders.c.order_estimated_delivery_date,
            ).order_by(orders.c.order_purchase_timestamp.desc()).limit(limit)
        ).mappings().all()
    return [
        {
            key: value.isoformat() if hasattr(value, "isoformat") else value
            for key, value in row.items()
        }
        for row in rows
    ]


def _meta_value(connection, key: str) -> str | None:
    return connection.execute(
        select(app_meta.c.value).where(app_meta.c.key == key)
    ).scalar_one_or_none()


def dataset_metadata() -> dict:
    sizes = table_sizes()
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
        live_runs = int(
            connection.execute(
                select(func.count(func.distinct(query_measurements.c.run_id)))
                .where(query_measurements.c.is_benchmark.is_(False))
            ).scalar_one()
        )
        uploaded_at = _meta_value(connection, "dataset_uploaded_at")
        latest_measurement = connection.execute(
            select(func.max(query_measurements.c.created_at))
        ).scalar_one()

    core_tables = ("customers", "products", "orders", "order_items")
    additional_tables = (
        "order_payments", "order_reviews", "sellers",
        "product_category_name_translation", "geolocation",
    )
    loaded = all(sizes[name] for name in core_tables)
    missing_additional = [name for name in additional_tables if sizes[name] == 0]
    table_file_names = {
        "order_payments": "olist_order_payments_dataset.csv",
        "order_reviews": "olist_order_reviews_dataset.csv",
        "sellers": "olist_sellers_dataset.csv",
        "product_category_name_translation": "product_category_name_translation.csv",
        "geolocation": "olist_geolocation_dataset.csv",
    }
    updated_at = latest_measurement.isoformat() if latest_measurement else uploaded_at
    return {
        "dataset_loaded": loaded,
        "dataset_name": DATASET_NAME,
        "source": DATASET_URL,
        "license": DATASET_LICENSE,
        "business_data": (
            "Real anonymized historical Olist records from Kaggle, stored in the shared Render PostgreSQL database."
            if loaded
            else "No business dataset is loaded. Upload the required Olist CSV files to begin."
        ),
        "upload_required_files": [
            "olist_customers_dataset.csv",
            "olist_orders_dataset.csv",
            "olist_order_items_dataset.csv",
            "olist_products_dataset.csv",
        ],
        "measurement_count": total,
        "live_query_count": live,
        "live_query_run_count": live_runs,
        "benchmark_count": total - live,
        "table_sizes": sizes,
        "table_count": sum(1 for count in sizes.values() if count > 0),
        "total_business_rows": sum(sizes.values()),
        "pending_additional_files": [table_file_names[name] for name in missing_additional],
        "uploaded_at": uploaded_at,
        "updated_at": updated_at,
    }


