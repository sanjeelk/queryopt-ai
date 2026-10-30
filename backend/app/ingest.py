"""Validated, streaming CSV import for the core Olist tables."""

from __future__ import annotations

import csv
import io
from datetime import datetime
from fastapi import UploadFile
from sqlalchemy import func, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

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
    sellers,
)

MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024
BATCH_SIZE = 2_000

CORE_COLUMNS = {
    "olist_customers_dataset.csv": {
        "customer_id", "customer_unique_id", "customer_zip_code_prefix",
        "customer_city", "customer_state",
    },
    "olist_orders_dataset.csv": {
        "order_id", "customer_id", "order_status", "order_purchase_timestamp",
        "order_approved_at", "order_delivered_carrier_date",
        "order_delivered_customer_date", "order_estimated_delivery_date",
    },
    "olist_order_items_dataset.csv": {
        "order_id", "order_item_id", "product_id", "seller_id",
        "shipping_limit_date", "price", "freight_value",
    },
    "olist_products_dataset.csv": {
        "product_id", "product_category_name", "product_name_lenght",
        "product_description_lenght", "product_photos_qty", "product_weight_g",
        "product_length_cm", "product_height_cm", "product_width_cm",
    },
}
SUPPLEMENTAL_COLUMNS = {
    "olist_geolocation_dataset.csv": {
        "geolocation_zip_code_prefix", "geolocation_lat", "geolocation_lng",
        "geolocation_city", "geolocation_state",
    },
    "olist_order_payments_dataset.csv": {
        "order_id", "payment_sequential", "payment_type",
        "payment_installments", "payment_value",
    },
    "olist_order_reviews_dataset.csv": {
        "review_id", "order_id", "review_score", "review_comment_title",
        "review_comment_message", "review_creation_date", "review_answer_timestamp",
    },
    "olist_sellers_dataset.csv": {
        "seller_id", "seller_zip_code_prefix", "seller_city", "seller_state",
    },
    "product_category_name_translation.csv": {
        "product_category_name", "product_category_name_english",
    },
}
TABLES = {
    "olist_customers_dataset.csv": customers,
    "olist_products_dataset.csv": products,
    "olist_orders_dataset.csv": orders,
    "olist_order_items_dataset.csv": order_items,
    "olist_geolocation_dataset.csv": geolocation,
    "olist_order_payments_dataset.csv": order_payments,
    "olist_order_reviews_dataset.csv": order_reviews,
    "olist_sellers_dataset.csv": sellers,
    "product_category_name_translation.csv": product_category_name_translation,
}
REQUIRED_COLUMNS = CORE_COLUMNS | SUPPLEMENTAL_COLUMNS
CORE_FILES = set(CORE_COLUMNS)
INTEGER_COLUMNS = {
    "customer_zip_code_prefix", "product_name_lenght",
    "product_description_lenght", "product_photos_qty", "order_item_id",
    "geolocation_zip_code_prefix", "payment_sequential",
    "payment_installments", "review_score", "seller_zip_code_prefix",
}
FLOAT_COLUMNS = {
    "product_weight_g", "product_length_cm", "product_height_cm",
    "product_width_cm", "price", "freight_value",
    "geolocation_lat", "geolocation_lng", "payment_value",
}
DATETIME_COLUMNS = {
    "order_purchase_timestamp", "order_approved_at",
    "order_delivered_carrier_date", "order_delivered_customer_date",
    "order_estimated_delivery_date", "shipping_limit_date",
    "review_creation_date", "review_answer_timestamp",
}


def _safe_filename(filename: str | None) -> str:
    if not filename:
        raise ValueError("One uploaded file has no filename.")
    return filename.replace("\\", "/").rsplit("/", 1)[-1]


def _file_size(upload: UploadFile) -> int:
    if upload.size is not None:
        return int(upload.size)
    upload.file.seek(0, io.SEEK_END)
    size = upload.file.tell()
    upload.file.seek(0)
    return size


def _check_headers(upload: UploadFile, filename: str) -> None:
    upload.file.seek(0)
    text = io.TextIOWrapper(upload.file, encoding="utf-8-sig", newline="")
    try:
        reader = csv.reader(text)
        headers = next(reader, None)
        if not headers:
            raise ValueError(f"{filename} is empty.")
        missing = sorted(REQUIRED_COLUMNS[filename] - set(headers))
        if missing:
            raise ValueError(
                f"{filename} is missing expected Olist columns: {', '.join(missing)}."
            )
    except UnicodeDecodeError as error:
        raise ValueError(f"{filename} must be a UTF-8 CSV file.") from error
    finally:
        # Keep FastAPI's UploadFile open for the streaming import pass.
        try:
            text.detach()
        except ValueError:
            pass
    upload.file.seek(0)


def _convert(value: str | None, column: str):
    if value is None:
        return None
    value = value.strip()
    if value == "":
        return None
    try:
        if column in INTEGER_COLUMNS:
            return int(value)
        if column in FLOAT_COLUMNS:
            return float(value)
        if column in DATETIME_COLUMNS:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=None)
        return value
    except (TypeError, ValueError) as error:
        raise ValueError(f"Invalid value for Olist column '{column}'.") from error


def _insert_file(connection, upload: UploadFile, filename: str) -> int:
    upload.file.seek(0)
    text = io.TextIOWrapper(upload.file, encoding="utf-8-sig", newline="")
    count = 0
    batch = []
    table = TABLES[filename]
    try:
        reader = csv.DictReader(text)
        for raw in reader:
            if None in raw:
                raise ValueError(f"{filename} contains a malformed CSV row.")
            row = {
                column.name: _convert(raw.get(column.name), column.name)
                for column in table.columns
                if column.name in raw
            }
            # Preserve every declared table column; optional source fields may be blank.
            for column in table.columns:
                if column.name not in row and column.autoincrement is not True:
                    row[column.name] = None
            batch.append(row)
            if len(batch) >= BATCH_SIZE:
                connection.execute(insert(table), batch)
                count += len(batch)
                batch.clear()
        if batch:
            connection.execute(insert(table), batch)
            count += len(batch)
    except UnicodeDecodeError as error:
        raise ValueError(f"{filename} must be a UTF-8 CSV file.") from error
    finally:
        try:
            text.detach()
        except ValueError:
            pass
    if count == 0:
        raise ValueError(f"{filename} has a header but no data rows.")
    return count


def import_olist_files(files: list[UploadFile]) -> dict:
    """Import real Olist tables once, allowing the five supplemental files later."""
    supplied: dict[str, UploadFile] = {}
    total_size = 0
    accepted = set(REQUIRED_COLUMNS)

    for upload in files:
        filename = _safe_filename(upload.filename)
        if filename not in accepted:
            raise ValueError(
                f"Unexpected file '{filename}'. Choose CSVs from the Olist Kaggle dataset."
            )
        if filename in supplied:
            raise ValueError(f"{filename} was selected more than once.")
        supplied[filename] = upload
        total_size += _file_size(upload)

    if not supplied:
        raise ValueError("Choose at least one Olist Kaggle CSV file.")
    if total_size > MAX_TOTAL_UPLOAD_BYTES:
        raise ValueError(
            "Selected files exceed the 100 MB upload limit. Upload the core files first, then add the remaining Olist files."
        )

    for filename, upload in supplied.items():
        _check_headers(upload, filename)

    counts = {}
    try:
        with engine.begin() as connection:
            # Prevent two first uploads from racing against each other.
            connection.exec_driver_sql("SELECT pg_advisory_xact_lock(91204026)")
            existing = {
                table.name: int(
                    connection.execute(
                        select(func.count()).select_from(table)
                    ).scalar_one()
                )
                for table in TABLES.values()
            }
            core_loaded = all(existing[TABLES[filename].name] > 0 for filename in CORE_FILES)
            if core_loaded:
                if CORE_FILES.intersection(supplied):
                    raise ValueError("The core Olist tables are already loaded. Choose only the five additional Olist CSV files.")
                already_loaded = [
                    TABLES[filename].name
                    for filename in supplied
                    if existing[TABLES[filename].name] > 0
                ]
                if already_loaded:
                    raise ValueError("These Olist tables are already loaded: " + ", ".join(already_loaded) + ".")
            else:
                missing_files = sorted(CORE_FILES - supplied.keys())
                if missing_files:
                    raise ValueError("Select all four required core files: " + ", ".join(missing_files) + ".")
                if any(existing.values()):
                    raise ValueError("The database has a partial Olist import. No new files were applied.")

            for filename, upload in supplied.items():
                table = TABLES[filename]
                counts[table.name] = _insert_file(connection, upload, filename)

            from datetime import datetime, timezone

            uploaded_at = datetime.now(timezone.utc).isoformat()
            existing_uploaded_at = connection.execute(
                select(app_meta.c.value).where(app_meta.c.key == "dataset_uploaded_at")
            ).scalar_one_or_none()
            metadata_rows = [
                {"key": "dataset_name", "value": "Brazilian E-Commerce Public Dataset by Olist"},
                {"key": "dataset_uploaded_at", "value": existing_uploaded_at or uploaded_at},
                {"key": "dataset_last_updated_at", "value": uploaded_at},
                {"key": "dataset_license", "value": "CC BY-NC-SA 4.0"},
                {"key": "dataset_source", "value": "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce"},
            ]
            for item in metadata_rows:
                connection.execute(
                    pg_insert(app_meta)
                    .values(**item)
                    .on_conflict_do_update(
                        index_elements=[app_meta.c.key],
                        set_={"value": item["value"]},
                    )
                )
            for table_name in counts:
                connection.exec_driver_sql(f"ANALYZE {table_name}")
    except IntegrityError as error:
        raise ValueError(
            "The CSV files contain duplicate or invalid IDs. Check that the files come from the same Olist download."
        ) from error

    return {
        "dataset_name": "Brazilian E-Commerce Public Dataset by Olist",
        "table_sizes": counts,
        "uploaded_at": uploaded_at,
    }


