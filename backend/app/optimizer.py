"""Safe SELECT-only plan comparison and a workload-trained ML recommender."""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from datetime import datetime, timezone

import sqlglot
from sqlglot import exp
from sqlalchemy import desc, insert, select
from sqlalchemy.exc import DBAPIError
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, cross_val_predict

from .db import engine, query_measurements


STRATEGIES = {
    "planner_default": {},
    "index_friendly": {"enable_seqscan": "off"},
    "join_friendly": {"enable_nestloop": "off"},
    "parallel_friendly": {"max_parallel_workers_per_gather": "2"},
}
ALLOWED_TABLES = {"customers", "products", "orders", "order_items"}
ALLOWED_ANONYMOUS_FUNCTIONS = {"COALESCE", "NULLIF", "GREATEST", "LEAST"}
ALLOWED_BUILTIN_FUNCTIONS = {
    "COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND", "ABS", "LOWER", "UPPER",
    "COALESCE", "NULLIF", "GREATEST", "LEAST",
}
MAX_QUERY_CHARS = 4_000
STATEMENT_TIMEOUT_MS = 1_800


def validate_query(sql: str) -> tuple[str, str]:
    sql = sql.strip()
    if not sql or len(sql) > MAX_QUERY_CHARS:
        raise ValueError(f"Query must contain 1 to {MAX_QUERY_CHARS} characters.")
    try:
        statements = sqlglot.parse(sql, read="postgres")
    except sqlglot.errors.ParseError as error:
        raise ValueError("Could not parse this PostgreSQL query.") from error
    if len(statements) != 1 or not isinstance(statements[0], exp.Select):
        raise ValueError("Only one SELECT query is allowed.")

    tree = statements[0]
    if tree.args.get("with") is not None:
        raise ValueError("Common table expressions are disabled in this query runner.")
    tables = list(tree.find_all(exp.Table))
    if not tables:
        raise ValueError("Query must read from customers, products, orders, or order_items.")
    for table in tables:
        if table.name.lower() not in ALLOWED_TABLES or table.db or table.catalog:
            raise ValueError("Queries can read only customers, products, orders, and order_items.")
    for function in tree.find_all(exp.Anonymous):
        if function.name.upper() not in ALLOWED_ANONYMOUS_FUNCTIONS:
            raise ValueError(f"Function {function.name} is not available in the query runner.")
    for function in tree.find_all(exp.Func):
        name = function.sql_name().upper()
        if name not in ALLOWED_BUILTIN_FUNCTIONS and not isinstance(function, exp.Anonymous):
            raise ValueError(f"Function {name} is not available in the query runner.")

    normalized = tree.sql(dialect="postgres", pretty=False)
    key = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return normalized, key


def _features(sql: str, strategy: str) -> list[float]:
    tree = sqlglot.parse_one(sql, read="postgres")
    words = sql.lower()
    tables = len({table.name.lower() for table in tree.find_all(exp.Table)})
    joins = len(list(tree.find_all(exp.Join)))
    limit = next(tree.find_all(exp.Limit), None)
    limit_value = 0.0
    if limit is not None:
        try:
            limit_value = min(float(limit.expression.this), 1_000.0)
        except (AttributeError, TypeError, ValueError):
            limit_value = 0.0
    core = [
        math.log1p(len(sql)),
        float(tables),
        float(joins),
        float("where" in words),
        float("group by" in words),
        float("order by" in words),
        float(any(token in words for token in ("count(", "sum(", "avg(", "min(", "max("))),
        float(sum(words.count(operator) for operator in ("=", "<", ">", " like ", " in "))),
        math.log1p(limit_value),
    ]
    return core + [float(candidate == strategy) for candidate in STRATEGIES]


def _model():
    with engine.connect() as connection:
        rows = connection.execute(
            select(
                query_measurements.c.query_text,
                query_measurements.c.strategy,
                query_measurements.c.execution_ms,
            )
            .order_by(desc(query_measurements.c.created_at))
            .limit(2_000)
        ).mappings().all()

    query_keys = set()
    samples = []
    targets = []
    for row in rows:
        if row["strategy"] not in STRATEGIES:
            continue
        try:
            normalized, key = validate_query(row["query_text"])
        except ValueError:
            continue
        query_keys.add(key)
        samples.append(_features(normalized, row["strategy"]))
        targets.append(math.log1p(max(float(row["execution_ms"]), 0.001)))

    if len(samples) < 16 or len(query_keys) < 3:
        return None, {"status": "warming_up", "samples": len(samples), "query_shapes": len(query_keys)}

    model = RandomForestRegressor(
        n_estimators=120,
        min_samples_leaf=2,
        max_features=0.9,
        random_state=42,
        n_jobs=1,
    )
    model.fit(samples, targets)
    return model, {"status": "trained", "samples": len(samples), "query_shapes": len(query_keys)}


def _walk_plan(root: dict) -> list[dict]:
    flattened = []

    def visit(node: dict, depth: int = 0) -> None:
        flattened.append(
            {
                "node_type": node.get("Node Type", "Unknown"),
                "relation": node.get("Relation Name"),
                "estimated_rows": node.get("Plan Rows"),
                "actual_rows": node.get("Actual Rows"),
                "estimated_cost": node.get("Total Cost"),
                "actual_time_ms": node.get("Actual Total Time"),
                "depth": depth,
            }
        )
        for child in node.get("Plans", []):
            visit(child, depth + 1)

    visit(root)
    return flattened


def _measure_once(
    sql: str,
    query_key: str,
    run_id: str,
    strategy: str,
    settings: dict,
    is_benchmark: bool,
    predicted_ms: float | None = None,
) -> dict:
    settings_sql = [
        f"SET LOCAL {name} = '{value}'" for name, value in settings.items()
    ]
    explain_sql = f"EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT JSON) {sql}"
    with engine.begin() as connection:
        connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        connection.exec_driver_sql(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT_MS}ms'")
        for statement in settings_sql:
            connection.exec_driver_sql(statement)
        raw = connection.exec_driver_sql(explain_sql).scalar_one()

    if isinstance(raw, str):
        raw = json.loads(raw)
    payload = raw[0] if isinstance(raw, list) else raw
    root = payload["Plan"]
    execution_ms = float(payload.get("Execution Time", root.get("Actual Total Time", 0.0)))
    result = {
        "strategy": strategy,
        "execution_ms": execution_ms,
        "planning_ms": float(payload.get("Planning Time", 0.0)),
        "estimated_cost": float(root.get("Total Cost", 0.0)),
        "actual_rows": int(root.get("Actual Rows", 0)),
        "predicted_ms": predicted_ms,
        "shared_hit_blocks": int(root.get("Shared Hit Blocks", 0)),
        "shared_read_blocks": int(root.get("Shared Read Blocks", 0)),
        "plan": _walk_plan(root),
        "plan_json": payload,
        "is_benchmark": is_benchmark,
    }

    with engine.begin() as connection:
        connection.execute(
            insert(query_measurements).values(
                query_key=query_key,
                run_id=run_id,
                query_text=sql,
                strategy=strategy,
                execution_ms=result["execution_ms"],
                estimated_cost=result["estimated_cost"],
                actual_rows=result["actual_rows"],
                predicted_ms=predicted_ms,
                shared_hit_blocks=result["shared_hit_blocks"],
                shared_read_blocks=result["shared_read_blocks"],
                plan_json=payload,
                is_benchmark=is_benchmark,
                created_at=datetime.now(timezone.utc),
            )
        )
    return result


def run_candidates(sql: str, is_benchmark: bool = False) -> int:
    normalized, query_key = validate_query(sql)
    run_id = str(uuid.uuid4())
    recorded = 0
    for strategy, settings in STRATEGIES.items():
        _measure_once(normalized, query_key, run_id, strategy, settings, is_benchmark)
        recorded += 1
    return recorded


def _sample_rows(sql: str) -> list[dict]:
    with engine.begin() as connection:
        connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        connection.exec_driver_sql(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT_MS}ms'")
        result = connection.exec_driver_sql(sql)
        columns = list(result.keys())
        rows = result.fetchmany(12)
    return [
        {
            key: value.isoformat() if hasattr(value, "isoformat") else float(value) if hasattr(value, "as_tuple") else value
            for key, value in zip(columns, row)
        }
        for row in rows
    ]


def analyze_query(sql: str) -> dict:
    normalized, _ = validate_query(sql)
    model, model_status = _model()
    run_id = str(uuid.uuid4())
    predicted = {}
    if model is not None:
        for strategy in STRATEGIES:
            predicted[strategy] = math.expm1(float(model.predict([_features(normalized, strategy)])[0]))

    measured = []
    errors = []
    for strategy, settings in STRATEGIES.items():
        try:
            measured.append(
                _measure_once(
                    normalized,
                    validate_query(normalized)[1],
                    run_id,
                    strategy,
                    settings,
                    False,
                    predicted.get(strategy),
                )
            )
        except DBAPIError:
            errors.append({"strategy": strategy, "message": "PostgreSQL could not complete this candidate within the query limit."})

    if not measured:
        raise ValueError("PostgreSQL could not complete this query within the time limit. Try a simpler query over the Olist tables.")

    if model is not None:
        selected = min(predicted, key=predicted.get)
        selection_source = "random_forest"
    else:
        selected = "planner_default"
        selection_source = "measured_warmup"

    selected_result = next((candidate for candidate in measured if candidate["strategy"] == selected), None)
    if selected_result is None:
        selected_result = min(measured, key=lambda candidate: candidate["execution_ms"])
        selected = selected_result["strategy"]
        selection_source = "measured_fallback"

    default = next((candidate for candidate in measured if candidate["strategy"] == "planner_default"), None)
    fastest_actual = min(measured, key=lambda candidate: candidate["execution_ms"])
    return {
        "query": normalized,
        "query_key": validate_query(normalized)[1],
        "model": {"algorithm": "Random Forest Regressor", **model_status},
        "selection_source": selection_source,
        "recommended_strategy": selected,
        "predicted_execution_ms": predicted.get(selected),
        "actual_fastest_strategy": fastest_actual["strategy"],
        "default_execution_ms": default["execution_ms"] if default else None,
        "recommended_execution_ms": selected_result["execution_ms"],
        "candidates": [
            {
                key: value
                for key, value in candidate.items()
                if key not in {"plan_json", "is_benchmark"}
            }
            | {"predicted_execution_ms": predicted.get(candidate["strategy"])}
            for candidate in measured
        ],
        "unavailable_candidates": errors,
        "plan": selected_result["plan"],
        "result_preview": _sample_rows(normalized),
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "note": "Execution times are measured on the uploaded Olist data and vary with cache, load, and hosting tier.",
    }


def model_status() -> dict:
    _, status = _model()
    return {"algorithm": "Random Forest Regressor", **status}


def recent_measurements(limit: int = 25) -> list[dict]:
    with engine.connect() as connection:
        rows = connection.execute(
            select(query_measurements)
            .order_by(desc(query_measurements.c.created_at))
            .limit(max(1, min(limit, 100)))
        ).mappings().all()
    return [
        {
            "id": row["id"],
            "run_id": row["run_id"],
            "query_key": row["query_key"],
            "query": row["query_text"],
            "strategy": row["strategy"],
            "execution_ms": row["execution_ms"],
            "predicted_ms": row["predicted_ms"],
            "estimated_cost": row["estimated_cost"],
            "actual_rows": row["actual_rows"],
            "shared_hit_blocks": row["shared_hit_blocks"],
            "shared_read_blocks": row["shared_read_blocks"],
            "is_benchmark": row["is_benchmark"],
            "measured_at": row["created_at"].isoformat(),
        }
        for row in rows
    ]


def model_comparison() -> dict:
    """Evaluate the three synopsis models without leaking a query shape across folds."""
    with engine.connect() as connection:
        rows = connection.execute(
            select(
                query_measurements.c.query_key,
                query_measurements.c.query_text,
                query_measurements.c.strategy,
                query_measurements.c.execution_ms,
            )
            .order_by(query_measurements.c.id)
            .limit(2_000)
        ).mappings().all()

    samples, targets, groups = [], [], []
    for row in rows:
        if row["strategy"] not in STRATEGIES:
            continue
        try:
            normalized, _ = validate_query(row["query_text"])
        except ValueError:
            continue
        samples.append(_features(normalized, row["strategy"]))
        targets.append(float(row["execution_ms"]))
        groups.append(row["query_key"])

    shape_count = len(set(groups))
    if len(samples) < 16 or shape_count < 4:
        return {
            "status": "warming_up",
            "validation": "query-shape grouped cross-validation",
            "samples": len(samples),
            "query_shapes": shape_count,
            "items": [],
        }

    cv = GroupKFold(n_splits=min(5, shape_count))
    estimators = [
        ("Linear Regression", LinearRegression()),
        (
            "Random Forest",
            RandomForestRegressor(
                n_estimators=120,
                min_samples_leaf=2,
                max_features=0.9,
                random_state=42,
                n_jobs=1,
            ),
        ),
        (
            "Gradient Boosting",
            GradientBoostingRegressor(
                n_estimators=80,
                max_depth=2,
                learning_rate=0.06,
                random_state=42,
            ),
        ),
    ]
    metrics = []
    for name, estimator in estimators:
        predictions = cross_val_predict(estimator, samples, targets, groups=groups, cv=cv, n_jobs=1)
        mse = float(mean_squared_error(targets, predictions))
        metrics.append(
            {
                "model": name,
                "mae": float(mean_absolute_error(targets, predictions)),
                "mse": mse,
                "rmse": math.sqrt(mse),
                "r2": float(r2_score(targets, predictions)) if len(set(targets)) > 1 else None,
            }
        )
    best = min(metrics, key=lambda item: item["rmse"])
    return {
        "status": "evaluated",
        "validation": "query-shape grouped cross-validation",
        "samples": len(samples),
        "query_shapes": shape_count,
        "items": metrics,
        "best_model": best["model"],
        "note": "Metrics use held-out query shapes; timing noise can make R² negative.",
    }


def dataset_rows(limit: int = 100) -> list[dict]:
    with engine.connect() as connection:
        rows = connection.execute(
            select(query_measurements)
            .order_by(desc(query_measurements.c.created_at))
            .limit(max(1, min(limit, 500)))
        ).mappings().all()

    records = []
    for row in rows:
        sql = row["query_text"]
        tree = sqlglot.parse_one(sql, read="postgres")
        root = (row["plan_json"] or {}).get("Plan", {})
        nodes = _walk_plan(root)
        node_types = [node["node_type"] for node in nodes]
        scan_nodes = [name for name in node_types if "Scan" in name]
        if any("Bitmap" in name for name in scan_nodes):
            scan_type = "Bitmap"
        elif any("Index" in name for name in scan_nodes):
            scan_type = "Index"
        elif scan_nodes:
            scan_type = "Sequential"
        else:
            scan_type = "—"

        join_types = [
            name.removesuffix(" Join")
            for name in node_types
            if name in {"Hash Join", "Nested Loop", "Merge Join"}
        ]
        table_count = len({table.name.lower() for table in tree.find_all(exp.Table)})
        joins = len(list(tree.find_all(exp.Join)))
        has_where = bool(tree.args.get("where"))
        filter_count = sum(
            1
            for node in tree.walk()
            if node.__class__.__name__ in {"EQ", "GT", "GTE", "LT", "LTE", "NEQ", "In", "Like"}
        )
        aggregate_count = sum(
            1
            for function in tree.find_all(exp.Func)
            if function.sql_name().upper() in {"COUNT", "SUM", "AVG", "MIN", "MAX"}
        )
        if joins > 1:
            query_type = "Multi-Join"
        elif joins:
            query_type = "Join Query"
        elif aggregate_count:
            query_type = "Aggregation"
        elif has_where:
            query_type = "Filtered SELECT"
        else:
            query_type = "Simple SELECT"
        records.append(
            {
                "query_id": row["id"],
                "run_id": row["run_id"],
                "query_key": row["query_key"],
                "query_type": query_type,
                "num_tables": table_count,
                "num_joins": joins,
                "num_filters": filter_count,
                "num_aggregations": aggregate_count,
                "plan_type": node_types[0] if node_types else "—",
                "scan_type": scan_type,
                "join_type": join_types[0] if join_types else "None",
                "estimated_cost": row["estimated_cost"],
                "estimated_rows": root.get("Plan Rows"),
                "plan_depth": _plan_depth(root),
                "num_nodes": len(nodes),
                "predicted_time": row["predicted_ms"],
                "actual_time": row["execution_ms"],
                "strategy": row["strategy"],
                "is_benchmark": row["is_benchmark"],
                "measured_at": row["created_at"].isoformat(),
                "sql": sql,
            }
        )
    return records


def _plan_depth(node: dict) -> int:
    children = node.get("Plans", [])
    return 1 + max((_plan_depth(child) for child in children), default=0)

