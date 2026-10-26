"""PostgreSQL connection and shared schema for QueryOpt AI."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    JSON,
    MetaData,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    create_engine,
)


def _database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError(
            "DATABASE_URL is required. Set it to a PostgreSQL connection URL."
        )
    if value.startswith("postgres://"):
        value = "postgresql+psycopg://" + value.removeprefix("postgres://")
    elif value.startswith("postgresql://"):
        value = "postgresql+psycopg://" + value.removeprefix("postgresql://")
    return value


engine = create_engine(_database_url(), pool_pre_ping=True, pool_size=5, max_overflow=5)
metadata = MetaData()

app_meta = Table(
    "app_meta",
    metadata,
    # A small key/value table makes first-run data and benchmark seeding idempotent.
    Column("key", String(80), primary_key=True),
    Column("value", String(300), nullable=False),
)

customers = Table(
    "customers",
    metadata,
    Column("customer_id", String(36), primary_key=True),
    Column("customer_unique_id", String(36), nullable=False),
    Column("customer_zip_code_prefix", Integer),
    Column("customer_city", String(120)),
    Column("customer_state", String(2)),
)
Index("customers_state_idx", customers.c.customer_state)
Index("customers_city_idx", customers.c.customer_city)

products = Table(
    "products",
    metadata,
    Column("product_id", String(36), primary_key=True),
    Column("product_category_name", String(120)),
    Column("product_name_lenght", Integer),
    Column("product_description_lenght", Integer),
    Column("product_photos_qty", Integer),
    Column("product_weight_g", Float),
    Column("product_length_cm", Float),
    Column("product_height_cm", Float),
    Column("product_width_cm", Float),
)
Index("products_category_idx", products.c.product_category_name)

orders = Table(
    "orders",
    metadata,
    Column("order_id", String(36), primary_key=True),
    Column("customer_id", String(36), nullable=False),
    Column("order_status", String(30), nullable=False),
    Column("order_purchase_timestamp", DateTime(timezone=False)),
    Column("order_approved_at", DateTime(timezone=False)),
    Column("order_delivered_carrier_date", DateTime(timezone=False)),
    Column("order_delivered_customer_date", DateTime(timezone=False)),
    Column("order_estimated_delivery_date", DateTime(timezone=False)),
)
Index("orders_customer_idx", orders.c.customer_id)
Index("orders_purchase_idx", orders.c.order_purchase_timestamp)
Index("orders_status_idx", orders.c.order_status)

order_items = Table(
    "order_items",
    metadata,
    Column("order_id", String(36), nullable=False),
    Column("order_item_id", Integer, nullable=False),
    Column("product_id", String(36), nullable=False),
    Column("seller_id", String(36), nullable=False),
    Column("shipping_limit_date", DateTime(timezone=False)),
    Column("price", Float, nullable=False),
    Column("freight_value", Float, nullable=False),
    PrimaryKeyConstraint("order_id", "order_item_id"),
)
Index("order_items_order_idx", order_items.c.order_id)
Index("order_items_product_idx", order_items.c.product_id)
Index("order_items_seller_idx", order_items.c.seller_id)

query_measurements = Table(
    "query_measurements",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("query_key", String(64), nullable=False, index=True),
    Column("run_id", String(36), nullable=False, index=True),
    Column("query_text", Text, nullable=False),
    Column("strategy", String(40), nullable=False, index=True),
    Column("execution_ms", Float, nullable=False),
    Column("estimated_cost", Float, nullable=False),
    Column("actual_rows", Integer, nullable=False),
    Column("predicted_ms", Float, nullable=True),
    Column("shared_hit_blocks", Integer, nullable=False),
    Column("shared_read_blocks", Integer, nullable=False),
    Column("plan_json", JSON, nullable=False),
    Column("is_benchmark", Boolean, nullable=False, default=False),
    Column(
        "created_at",
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    ),
)


def initialize_schema() -> None:
    metadata.create_all(engine)

