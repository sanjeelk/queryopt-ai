import { withSupabase } from "npm:@supabase/server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const strategies = ["planner_default", "index_friendly", "join_friendly", "parallel_friendly"] as const;
type Strategy = typeof strategies[number];
type Row = Record<string, any>;
type Sample = { x: number[]; y: number; queryKey: string };
type Tree = { value: number; feature?: number; threshold?: number; left?: Tree; right?: Tree };

const sourceQueries = [
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
];

const coreTables = ["customers", "orders", "order_items", "products"];
const supplementalTables = ["order_payments", "order_reviews", "sellers", "product_category_name_translation", "geolocation"];
const allTables = [...coreTables, ...supplementalTables];
const allowedTables = new Set(allTables);
const allowedFunctions = new Set([
  "count", "sum", "avg", "min", "max", "round", "abs", "lower", "upper",
  "coalesce", "nullif", "greatest", "least", "in",
]);
const forbiddenTokens = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|deallocate|vacuum|refresh|lock|set|reset|into|union|intersect|except|with|for)\b/i;
const queryRate = new Map<string, number[]>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400) {
  return json({ detail: message }, status);
}

async function bodyJson(req: Request): Promise<Row> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 1_500_000) throw new Error("Request is too large. Send CSV data in smaller batches.");
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object.");
  return body as Row;
}

function requireNoError<T>(result: { data: T; error: { message?: string } | null }): T {
  if (result.error) throw new Error(result.error.message || "Database request failed.");
  return result.data;
}

function normalizeQuery(input: unknown): string {
  if (typeof input !== "string") throw new Error("Enter a SQL SELECT query.");
  let query = input.trim().replace(/;\s*$/, "").trim();
  if (!query || query.length > 4000) throw new Error("Query must contain 1 to 4,000 characters.");
  if (!/^select\s/i.test(query)) throw new Error("Only one read-only SELECT query is allowed.");
  if (/[;]|--|\/\*|\*\/|\$\$|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) {
    throw new Error("SQL comments and multiple statements are not allowed.");
  }

  const unquoted = query.replace(/'(?:''|[^'])*'/g, "''");
  if (forbiddenTokens.test(unquoted) || (unquoted.match(/\bselect\b/gi) || []).length !== 1) {
    throw new Error("Only one read-only SELECT query is allowed.");
  }
  const tableMatches = [...unquoted.matchAll(/\b(from|join)\s+([^\s,()]+)/gi)];
  if (!tableMatches.length) throw new Error("Query must read from customers, products, orders, or order_items.");
  for (const match of tableMatches) {
    const tableName = String(match[2]).replaceAll('"', "").toLowerCase();
    if (!allowedTables.has(tableName) || tableName !== match[2].toLowerCase()) {
      throw new Error("Queries can read only customers, products, orders, and order_items.");
    }
  }
  const fromStart = unquoted.search(/\bfrom\s+/i);
  if (fromStart >= 0) {
    let depth = 0;
    let inFrom = true;
    for (let i = fromStart + 4; i < unquoted.length && inFrom; i++) {
      const char = unquoted[i];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0 && char === ",") throw new Error("Use explicit JOIN clauses instead of comma joins.");
      if (depth === 0 && /^\s*(?:where\b|group\s+by\b|order\s+by\b|having\b|limit\b|offset\b|fetch\b)/i.test(unquoted.slice(i))) inFrom = false;
    }
  }
  for (const match of unquoted.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const fn = match[1].toLowerCase();
    if (!allowedFunctions.has(fn)) throw new Error(`Function ${match[1]} is not available in the query runner.`);
  }
  return query;
}

async function queryKey(query: string) {
  const data = new TextEncoder().encode(query.replace(/\s+/g, " ").toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function queryFeatures(query: string, strategy: Strategy): number[] {
  const normalized = query.toLowerCase();
  const tableNames = [...normalized.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1]);
  const limit = Number(normalized.match(/\blimit\s+(\d+)/)?.[1] || 0);
  const filterCount = (normalized.match(/(?:=|<>|!=|<=|>=|\blike\b|\bin\s*\()/g) || []).length;
  return [
    Math.log1p(query.length), new Set(tableNames).size, (normalized.match(/\bjoin\b/g) || []).length,
    Number(/\bwhere\b/.test(normalized)), Number(/\bgroup\s+by\b/.test(normalized)),
    Number(/\border\s+by\b/.test(normalized)), Number(/\b(count|sum|avg|min|max)\s*\(/.test(normalized)),
    filterCount, Math.log1p(Math.min(limit, 1000)), ...strategies.map((candidate) => Number(candidate === strategy)),
  ];
}

function measurementSamples(rows: Row[]): Sample[] {
  return rows.flatMap((row) => {
    if (!strategies.includes(row.strategy as Strategy) || typeof row.query_text !== "string") return [];
    try {
      return [{ x: queryFeatures(normalizeQuery(row.query_text), row.strategy as Strategy), y: Math.log1p(Math.max(Number(row.execution_ms), 0.001)), queryKey: row.query_key }];
    } catch {
      return [];
    }
  });
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function meanY(rows: Sample[]) {
  return rows.length ? rows.reduce((sum, row) => sum + row.y, 0) / rows.length : 0;
}

function buildTree(rows: Sample[], depth: number, maxDepth: number, minLeaf: number, random: () => number, featureBudget = 0): Tree {
  const value = meanY(rows);
  if (depth >= maxDepth || rows.length < minLeaf * 2 || !rows.length) return { value };
  const featureCount = rows[0].x.length;
  const indices = Array.from({ length: featureCount }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const features = indices.slice(0, featureBudget || featureCount);
  const baseError = rows.reduce((sum, row) => sum + (row.y - value) ** 2, 0);
  let best: { feature: number; threshold: number; error: number; left: Sample[]; right: Sample[] } | null = null;
  for (const feature of features) {
    const values = [...new Set(rows.map((row) => row.x[feature]))].sort((a, b) => a - b);
    if (values.length < 2) continue;
    const candidates = [0.2, 0.4, 0.6, 0.8].map((q) => values[Math.min(values.length - 2, Math.floor(q * (values.length - 1)))]);
    for (const threshold of candidates) {
      const left = rows.filter((row) => row.x[feature] <= threshold);
      const right = rows.filter((row) => row.x[feature] > threshold);
      if (left.length < minLeaf || right.length < minLeaf) continue;
      const leftMean = meanY(left); const rightMean = meanY(right);
      const error = left.reduce((sum, row) => sum + (row.y - leftMean) ** 2, 0)
        + right.reduce((sum, row) => sum + (row.y - rightMean) ** 2, 0);
      if (!best || error < best.error) best = { feature, threshold, error, left, right };
    }
  }
  if (!best || best.error >= baseError - 1e-8) return { value };
  return {
    value, feature: best.feature, threshold: best.threshold,
    left: buildTree(best.left, depth + 1, maxDepth, minLeaf, random, featureBudget),
    right: buildTree(best.right, depth + 1, maxDepth, minLeaf, random, featureBudget),
  };
}

function treePrediction(tree: Tree, x: number[]): number {
  if (tree.feature === undefined || tree.threshold === undefined || !tree.left || !tree.right) return tree.value;
  return treePrediction(x[tree.feature] <= tree.threshold ? tree.left : tree.right, x);
}

function trainForest(rows: Sample[], count = 18, maxDepth = 4, seed = 42): (x: number[]) => number {
  const random = seeded(seed);
  const featureBudget = Math.max(2, Math.floor(Math.sqrt(rows[0]?.x.length || 1)));
  const trees = Array.from({ length: count }, () => {
    const sample = Array.from({ length: Math.max(1, Math.floor(rows.length * 0.85)) }, () => rows[Math.floor(random() * rows.length)]);
    return buildTree(sample, 0, maxDepth, 3, random, featureBudget);
  });
  return (x) => trees.reduce((sum, tree) => sum + treePrediction(tree, x), 0) / Math.max(1, trees.length);
}

function trainLinear(rows: Sample[]): (x: number[]) => number {
  const dimensions = rows[0]?.x.length || 0;
  const means = Array.from({ length: dimensions }, (_, j) => rows.reduce((sum, row) => sum + row.x[j], 0) / rows.length);
  const scales = means.map((mean, j) => Math.sqrt(rows.reduce((sum, row) => sum + (row.x[j] - mean) ** 2, 0) / rows.length) || 1);
  const weights = Array(dimensions + 1).fill(0);
  for (let epoch = 0; epoch < 300; epoch++) {
    const gradient = Array(dimensions + 1).fill(0);
    for (const row of rows) {
      const standardized = row.x.map((value, j) => (value - means[j]) / scales[j]);
      const predicted = weights[0] + standardized.reduce((sum, value, j) => sum + value * weights[j + 1], 0);
      const error = predicted - row.y;
      gradient[0] += error;
      standardized.forEach((value, j) => { gradient[j + 1] += error * value; });
    }
    const rate = 0.08 / rows.length;
    weights.forEach((_, j) => { weights[j] -= rate * (gradient[j] + (j ? 0.01 * weights[j] : 0)); });
  }
  return (x) => weights[0] + x.reduce((sum, value, j) => sum + ((value - means[j]) / scales[j]) * weights[j + 1], 0);
}

function trainBoost(rows: Sample[], rounds = 10): (x: number[]) => number {
  let baseline = meanY(rows);
  const predictions = Array(rows.length).fill(baseline);
  const trees: Tree[] = [];
  for (let round = 0; round < rounds; round++) {
    const residuals = rows.map((row, i) => ({ ...row, y: row.y - predictions[i] }));
    const tree = buildTree(residuals, 0, 2, 4, seeded(1200 + round));
    trees.push(tree);
    rows.forEach((row, i) => { predictions[i] += 0.12 * treePrediction(tree, row.x); });
  }
  return (x) => baseline + trees.reduce((sum, tree) => sum + 0.12 * treePrediction(tree, x), 0);
}

function metrics(actual: number[], predicted: number[]) {
  const errors = actual.map((value, index) => value - predicted[index]);
  const mse = errors.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, errors.length);
  const mae = errors.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, errors.length);
  const average = actual.reduce((sum, value) => sum + value, 0) / Math.max(1, actual.length);
  const total = actual.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return { mae, mse, rmse: Math.sqrt(mse), r2: total > 0 ? 1 - errors.reduce((sum, value) => sum + value ** 2, 0) / total : null };
}

function evaluateModels(samples: Sample[]) {
  const groups = [...new Set(samples.map((sample) => sample.queryKey))].sort();
  if (samples.length < 16 || groups.length < 4) {
    return { status: "warming_up", validation: "query-shape grouped cross-validation", samples: samples.length, query_shapes: groups.length, items: [] as Row[] };
  }
  const folds = Math.min(5, groups.length);
  const names = ["Linear Regression", "Decision Tree", "Random Forest", "Gradient Boosting"];
  const actual = Array(names.length).fill(null).map(() => [] as number[]);
  const predicted = Array(names.length).fill(null).map(() => [] as number[]);
  for (let fold = 0; fold < folds; fold++) {
    const testKeys = new Set(groups.filter((_, index) => index % folds === fold));
    const train = samples.filter((sample) => !testKeys.has(sample.queryKey));
    const test = samples.filter((sample) => testKeys.has(sample.queryKey));
    if (!train.length || !test.length) continue;
    const decisionTree = buildTree(train, 0, 4, 3, seeded(501 + fold));
    const predictors = [
      trainLinear(train),
      (x: number[]) => treePrediction(decisionTree, x),
      trainForest(train, 8, 4, 700 + fold),
      trainBoost(train, 8),
    ];
    test.forEach((sample) => {
      const ms = Math.expm1(sample.y);
      predictors.forEach((predictor, index) => {
        actual[index].push(ms);
        predicted[index].push(Math.max(0, Math.expm1(predictor(sample.x))));
      });
    });
  }
  const items = names.map((model, index) => ({ model, ...metrics(actual[index], predicted[index]) }));
  return {
    status: "evaluated", validation: "query-shape grouped cross-validation", samples: samples.length,
    query_shapes: groups.length, items,
    best_model: items.reduce((best, item) => item.rmse < best.rmse ? item : best).model,
    note: "Metrics use held-out query shapes; timing noise can make R² negative.",
  };
}

function flattenPlan(root: Row) {
  const result: Row[] = [];
  const visit = (node: Row, depth = 0) => {
    result.push({
      node_type: node["Node Type"] || "Unknown", relation: node["Relation Name"] || null,
      estimated_rows: node["Plan Rows"] ?? null, actual_rows: node["Actual Rows"] ?? null,
      estimated_cost: node["Total Cost"] ?? null, actual_time_ms: node["Actual Total Time"] ?? null, depth,
    });
    for (const child of node.Plans || []) visit(child, depth + 1);
  };
  if (root && typeof root === "object") visit(root);
  return result;
}

function measurementFeatures(row: Row) {
  const nodes = flattenPlan(row.plan_json?.Plan || {});
  const types = nodes.map((node) => String(node.node_type));
  const scans = types.filter((type) => type.includes("Scan"));
  const joins = types.filter((type) => ["Hash Join", "Nested Loop", "Merge Join"].includes(type)).map((type) => type.replace(" Join", ""));
  const sql = String(row.query_text || "").toLowerCase();
  const tables = new Set([...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1]));
  const joinCount = (sql.match(/\bjoin\b/g) || []).length;
  const filterCount = (sql.match(/(?:=|<>|!=|<=|>=|\blike\b|\bin\s*\()/g) || []).length;
  const aggregateCount = (sql.match(/\b(count|sum|avg|min|max)\s*\(/g) || []).length;
  return {
    query_id: String(row.query_key || "").slice(0, 12),
    query_type: joinCount > 1 ? "Multi-Join" : joinCount ? "Join Query" : /\bgroup\s+by\b/.test(sql) ? "Aggregation" : /\bwhere\b/.test(sql) ? "Filter Query" : "Simple Scan",
    num_tables: tables.size, num_joins: joinCount, num_filters: filterCount, num_aggregations: aggregateCount,
    plan_type: types[0] || "—",
    scan_type: scans.some((type) => type.includes("Bitmap")) ? "Bitmap" : scans.some((type) => type.includes("Index")) ? "Index" : scans.length ? "Sequential" : "—",
    join_type: joins.join(", ") || "—", estimated_cost: Number(row.estimated_cost),
    estimated_rows: nodes[0]?.estimated_rows ?? null, plan_depth: Math.max(0, ...nodes.map((node) => node.depth)),
    num_nodes: nodes.length, predicted_time: row.predicted_ms, actual_time: row.execution_ms,
    is_benchmark: row.is_benchmark, run_id: row.run_id,
  };
}

async function countRows(db: any, table: string) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return Number(count || 0);
}

async function datasetMetadata(db: any) {
  const { data: latestImport, error: importError } = await db.from("dataset_imports")
    .select("table_sizes,status,completed_at,created_at").eq("status", "complete")
    .order("completed_at", { ascending: false }).limit(1).maybeSingle();
  if (importError) throw importError;
  let sizes = latestImport?.table_sizes;
  if (!sizes) {
    const values = await Promise.all(allTables.map((table) => countRows(db, table)));
    sizes = Object.fromEntries(allTables.map((name, index) => [name, values[index]]));
  }
  const [{ count: total, error: totalError }, { count: live, error: liveError }, { data: latestMeasure, error: latestError }, { data: meta, error: metaError }] = await Promise.all([
    db.from("query_measurements").select("id", { count: "exact", head: true }),
    db.from("query_measurements").select("id", { count: "exact", head: true }).eq("is_benchmark", false),
    db.from("query_measurements").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("app_meta").select("key,value").in("key", ["dataset_name", "dataset_uploaded_at", "dataset_last_updated_at", "dataset_license", "dataset_source"]),
  ]);
  if (totalError || liveError || latestError || metaError) throw totalError || liveError || latestError || metaError;
  const values = Object.fromEntries((meta || []).map((item: Row) => [item.key, item.value]));
  const measurementCount = Number(total || 0); const liveCount = Number(live || 0);
  const loaded = coreTables.every((table) => Number((sizes as Row)[table]) > 0);
  const { data: runRows, error: runError } = await db.from("query_measurements").select("run_id").eq("is_benchmark", false).limit(5000);
  if (runError) throw runError;
  const pendingAdditional = [
    ["order_payments", "olist_order_payments_dataset.csv"],
    ["order_reviews", "olist_order_reviews_dataset.csv"],
    ["sellers", "olist_sellers_dataset.csv"],
    ["product_category_name_translation", "product_category_name_translation.csv"],
    ["geolocation", "olist_geolocation_dataset.csv"],
  ].filter(([table]) => Number((sizes as Row)[table]) === 0).map(([, filename]) => filename);
  const totalBusinessRows = Object.values(sizes as Row).reduce((sum: number, value: any) => sum + Number(value || 0), 0);
  const loadedTables = Object.values(sizes as Row).filter((value: any) => Number(value) > 0).length;
  return {
    dataset_loaded: loaded,
    dataset_name: values.dataset_name || "Brazilian E-Commerce Public Dataset by Olist",
    source: values.dataset_source || "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce",
    license: values.dataset_license || "CC BY-NC-SA 4.0",
    business_data: loaded ? "Real anonymized historical Olist records from Kaggle, stored in the shared Supabase PostgreSQL database." : "No business dataset is loaded. Upload the required Olist CSV files to begin.",
    upload_required_files: loaded ? pendingAdditional : ["olist_customers_dataset.csv", "olist_orders_dataset.csv", "olist_order_items_dataset.csv", "olist_products_dataset.csv"],
    measurement_count: measurementCount, live_query_count: liveCount,
    live_query_run_count: new Set((runRows || []).map((row: Row) => row.run_id)).size, benchmark_count: measurementCount - liveCount,
    table_sizes: sizes, table_count: loadedTables, total_business_rows: totalBusinessRows,
    pending_additional_files: pendingAdditional,
    uploaded_at: values.dataset_uploaded_at || null,
    updated_at: latestMeasure?.created_at || values.dataset_last_updated_at || values.dataset_uploaded_at || null,
  };
}

async function trainingSamples(db: any) {
  const { data, error } = await db.from("query_measurements")
    .select("query_key,query_text,strategy,execution_ms").order("created_at", { ascending: false }).limit(1000);
  if (error) throw error;
  return measurementSamples(data || []);
}

async function optimize(db: any, sqlInput: unknown, benchmark = false) {
  const sql = normalizeQuery(sqlInput);
  const key = await queryKey(sql);
  const samples = await trainingSamples(db);
  const shapes = new Set(samples.map((sample) => sample.queryKey));
  const modelReady = samples.length >= 16 && shapes.size >= 4;
  const forestPredict = modelReady ? trainForest(samples, 18, 4, 9401) : null;
  const predictions = Object.fromEntries(strategies.map((strategy) => [
    strategy, forestPredict ? Math.max(0, Math.expm1(forestPredict(queryFeatures(sql, strategy)))) : null,
  ])) as Record<Strategy, number | null>;
  const runId = crypto.randomUUID();
  const candidates: Row[] = []; const errors: Row[] = [];
  for (const strategy of strategies) {
    const { data, error } = await db.rpc("run_explain", { p_query: sql, p_strategy: strategy });
    if (error) {
      errors.push({ strategy, message: "PostgreSQL could not complete this candidate within the query limit." });
      continue;
    }
    const candidate = {
      ...data,
      predicted_execution_ms: predictions[strategy],
      plan: flattenPlan(data.plan_json?.Plan || {}),
      is_benchmark: benchmark,
    };
    candidates.push(candidate);
  }
  if (!candidates.length) throw new Error("PostgreSQL could not complete this query within the time limit. Try a simpler query over the Olist tables.");

  const model = modelReady ? { algorithm: "Random Forest Regressor", status: "trained", samples: samples.length, query_shapes: shapes.size } : { algorithm: "Random Forest Regressor", status: "warming_up", samples: samples.length, query_shapes: shapes.size };
  const selectedName = modelReady ? [...strategies].sort((a, b) => Number(predictions[a]) - Number(predictions[b]))[0] : "planner_default";
  let selected = candidates.find((candidate) => candidate.strategy === selectedName);
  let selectionSource = modelReady ? "random_forest" : "measured_warmup";
  if (!selected) { selected = [...candidates].sort((a, b) => a.execution_ms - b.execution_ms)[0]; selectionSource = "measured_fallback"; }
  const defaultCandidate = candidates.find((candidate) => candidate.strategy === "planner_default");
  const fastest = [...candidates].sort((a, b) => a.execution_ms - b.execution_ms)[0];
  const { error: insertError } = await db.from("query_measurements").insert(candidates.map((candidate) => ({
    query_key: key, run_id: runId, query_text: sql, strategy: candidate.strategy,
    execution_ms: candidate.execution_ms, estimated_cost: candidate.estimated_cost,
    actual_rows: candidate.actual_rows, predicted_ms: candidate.predicted_execution_ms,
    shared_hit_blocks: candidate.shared_hit_blocks, shared_read_blocks: candidate.shared_read_blocks,
    plan_json: candidate.plan_json, is_benchmark: benchmark,
  })));
  if (insertError) throw insertError;
  const previewResult = await db.rpc("preview_olist_query", { p_query: sql });
  const preview = previewResult.error ? [] : previewResult.data;
  return {
    query: sql, query_key: key, model, selection_source: selectionSource,
    recommended_strategy: selected.strategy, predicted_execution_ms: selected.predicted_execution_ms,
    actual_fastest_strategy: fastest.strategy, default_execution_ms: defaultCandidate?.execution_ms ?? null,
    recommended_execution_ms: selected.execution_ms,
    candidates: candidates.map(({ plan_json, is_benchmark, ...candidate }) => candidate),
    unavailable_candidates: errors, plan: selected.plan, result_preview: preview,
    measured_at: new Date().toISOString(),
    note: "Execution times are measured on the uploaded Olist data and vary with cache, load, and hosting tier.",
  };
}

const requiredHeaders: Record<string, string[]> = {
  "olist_customers_dataset.csv": ["customer_id", "customer_unique_id", "customer_zip_code_prefix", "customer_city", "customer_state"],
  "olist_orders_dataset.csv": ["order_id", "customer_id", "order_status", "order_purchase_timestamp", "order_approved_at", "order_delivered_carrier_date", "order_delivered_customer_date", "order_estimated_delivery_date"],
  "olist_order_items_dataset.csv": ["order_id", "order_item_id", "product_id", "seller_id", "shipping_limit_date", "price", "freight_value"],
  "olist_products_dataset.csv": ["product_id", "product_category_name", "product_name_lenght", "product_description_lenght", "product_photos_qty", "product_weight_g", "product_length_cm", "product_height_cm", "product_width_cm"],
  "olist_order_payments_dataset.csv": ["order_id", "payment_sequential", "payment_type", "payment_installments", "payment_value"],
  "olist_order_reviews_dataset.csv": ["review_id", "order_id", "review_score", "review_comment_title", "review_comment_message", "review_creation_date", "review_answer_timestamp"],
  "olist_sellers_dataset.csv": ["seller_id", "seller_zip_code_prefix", "seller_city", "seller_state"],
  "product_category_name_translation.csv": ["product_category_name", "product_category_name_english"],
  "olist_geolocation_dataset.csv": ["geolocation_zip_code_prefix", "geolocation_lat", "geolocation_lng", "geolocation_city", "geolocation_state"],
};
const columnsByTable: Record<string, Set<string>> = {
  customers: new Set(requiredHeaders["olist_customers_dataset.csv"]),
  orders: new Set(requiredHeaders["olist_orders_dataset.csv"]),
  order_items: new Set(requiredHeaders["olist_order_items_dataset.csv"]),
  products: new Set(requiredHeaders["olist_products_dataset.csv"]),
  order_payments: new Set(requiredHeaders["olist_order_payments_dataset.csv"]),
  order_reviews: new Set(requiredHeaders["olist_order_reviews_dataset.csv"]),
  sellers: new Set(requiredHeaders["olist_sellers_dataset.csv"]),
  product_category_name_translation: new Set(requiredHeaders["product_category_name_translation.csv"]),
  geolocation: new Set([...requiredHeaders["olist_geolocation_dataset.csv"], "geolocation_id"]),
};
const conflicts: Record<string, string> = {
  customers: "customer_id", products: "product_id", orders: "order_id", order_items: "order_id,order_item_id",
  order_payments: "order_id,payment_sequential", order_reviews: "review_id,order_id", sellers: "seller_id",
  product_category_name_translation: "product_category_name", geolocation: "geolocation_id",
};

async function handle(req: Request, ctx: { supabaseAdmin: any }) {
  const db = ctx.supabaseAdmin;
  const url = new URL(req.url);
  const functionMarker = "/queryopt-api";
  const markerIndex = url.pathname.lastIndexOf(functionMarker);
  const path = markerIndex >= 0 ? url.pathname.slice(markerIndex + functionMarker.length) || "/" : url.pathname;

  if (req.method === "GET" && path === "/health") {
    const { error } = await db.from("app_meta").select("key").limit(1);
    if (error) throw error;
    return json({ status: "ok", database: "postgresql", service: "queryopt-api" });
  }

  if (req.method === "GET" && path === "/api/overview") {
    const dataset = await datasetMetadata(db);
    const { data, error } = await db.from("query_measurements").select("execution_ms,created_at").order("created_at", { ascending: false }).limit(1000);
    if (error) throw error;
    const measurements = data || [];
    const total = dataset.measurement_count; const live = dataset.live_query_count;
    const average = measurements.length ? measurements.reduce((sum: number, row: Row) => sum + Number(row.execution_ms), 0) / measurements.length : null;
    const [model, countLive] = await Promise.all([
      trainingSamples(db).then((samples) => evaluateModels(samples)),
      db.from("query_measurements").select("id", { count: "exact", head: true }).eq("is_benchmark", false),
    ]);
    if (countLive.error) throw countLive.error;
    return json({
      database: "PostgreSQL", data_mode: dataset.dataset_loaded ? "live_measurements" : "awaiting_dataset_upload",
      measurements: { total, benchmark: total - live, live: Number(countLive.count || 0) },
      average_execution_ms: average === null ? null : Number(average.toFixed(3)),
      latest_measurement_at: measurements[0]?.created_at || null,
      model: { algorithm: "Random Forest Regressor", status: model.status, samples: model.samples, query_shapes: model.query_shapes },
      dataset,
    });
  }

  if (req.method === "GET" && path === "/api/dataset") {
    const dataset = await datasetMetadata(db);
    const [{ data: businessPreview, error: ordersError }, { data: measurements, error: measurementsError }] = await Promise.all([
      db.from("orders").select("order_id,customer_id,order_status,order_purchase_timestamp,order_estimated_delivery_date").order("order_purchase_timestamp", { ascending: false }).limit(12),
      db.from("query_measurements").select("query_key,query_text,strategy,execution_ms,predicted_ms,estimated_cost,actual_rows,shared_hit_blocks,shared_read_blocks,plan_json,is_benchmark,run_id,created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    if (ordersError || measurementsError) throw ordersError || measurementsError;
    return json({
      ...dataset, feature_count: 14, target_variable: "Measured PostgreSQL execution time (milliseconds)",
      business_preview: dataset.dataset_loaded ? businessPreview || [] : [],
      items: (measurements || []).map(measurementFeatures),
      notes: dataset.dataset_loaded
        ? "Business rows come from uploaded Olist Kaggle CSV files. Query plans, costs, buffers, and execution times are collected from PostgreSQL at runtime."
        : "No business rows or benchmark results are preloaded. Upload the four Olist CSV files to begin.",
    });
  }

  if (req.method === "GET" && path === "/api/query-history") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 100)));
    const { data, error } = await db.from("query_measurements")
      .select("id,query_key,run_id,query_text,strategy,execution_ms,predicted_ms,estimated_cost,actual_rows,shared_hit_blocks,shared_read_blocks,is_benchmark,created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const items = (data || []).map((row: Row) => ({
      id: row.id, run_id: row.run_id, query_key: row.query_key, query: row.query_text,
      strategy: row.strategy, execution_ms: row.execution_ms, predicted_ms: row.predicted_ms,
      estimated_cost: row.estimated_cost, actual_rows: row.actual_rows,
      shared_hit_blocks: row.shared_hit_blocks, shared_read_blocks: row.shared_read_blocks,
      is_benchmark: row.is_benchmark, measured_at: row.created_at,
    }));
    return json({ items, count: items.length });
  }

  if (req.method === "GET" && path === "/api/models") {
    return json(evaluateModels(await trainingSamples(db)));
  }

  if (req.method === "GET" && path === "/api/examples") {
    return json({ items: sourceQueries.map((sql, index) => ({ id: `query-${index + 1}`, sql })) });
  }

  if (req.method === "POST" && path === "/api/optimize") {
    const body = await bodyJson(req);
    const meta = await datasetMetadata(db);
    if (!meta.dataset_loaded) return fail("Upload the Olist dataset from the Dataset page before optimizing queries.", 409);
    return json(await optimize(db, body.sql, body.is_benchmark === true));
  }

  if (req.method === "POST" && path === "/api/dataset/upload/start") {
    const body = await bodyJson(req);
    const kind = String(body.kind || "");
    const tables = body.tables;
    if (!Array.isArray(tables) || !tables.length || tables.length > 5 || tables.some((table) => typeof table !== "string" || !allowedTables.has(table))) {
      return fail("Choose valid Olist CSV files for this upload.");
    }
    if (kind === "core" && JSON.stringify(tables) !== JSON.stringify(coreTables)) return fail("Select all four core Olist CSV files together.");
    if (kind === "supplemental" && tables.some((table: string) => !supplementalTables.includes(table))) return fail("Only the five remaining Olist tables can be added.");
    if (kind !== "core" && kind !== "supplemental") return fail("Dataset upload type is invalid.");
    const { data, error } = await db.rpc("begin_olist_import", { p_kind: kind, p_tables: tables });
    if (error) throw error;
    return json({ upload_id: data, message: "Olist dataset upload started." });
  }

  if (req.method === "POST" && path === "/api/dataset/upload/batch") {
    const body = await bodyJson(req);
    const table = String(body.table || "");
    const rows = body.rows;
    if (!columnsByTable[table] || !Array.isArray(rows) || rows.length < 1 || rows.length > 4000) {
      return fail("Upload batch is not valid.");
    }
    if (typeof body.upload_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.upload_id)) return fail("Upload session is invalid.");
    const { data: session, error: sessionError } = await db.from("dataset_imports").select("status,kind,selected_tables").eq("id", body.upload_id).maybeSingle();
    if (sessionError) throw sessionError;
    if (!session || session.status !== "uploading") {
      return fail("Dataset upload session is not active.", 409);
    }
    if (!session.selected_tables?.includes(table)) return fail("This table is not part of the active upload.", 403);
    const allowed = columnsByTable[table];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some((key) => !allowed.has(key))) return fail("CSV columns do not match the selected Olist table.");
    }
    const { error } = await db.from(table).upsert(rows, { onConflict: conflicts[table] });
    if (error) throw error;
    return json({ accepted: rows.length });
  }

  if (req.method === "POST" && path === "/api/dataset/upload/complete") {
    const body = await bodyJson(req);
    if (typeof body.upload_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.upload_id)) return fail("Upload session is invalid.");
    const result = await db.rpc("finish_olist_import", { p_import_id: body.upload_id });
    if (result.error) throw result.error;
    const analyze = await db.rpc("analyze_olist_tables");
    if (analyze.error) throw analyze.error;
    return json({ message: "Olist dataset imported successfully.", dataset: await datasetMetadata(db), uploaded_table_sizes: result.data?.table_sizes || {} });
  }

  return fail("Route not found.", 404);
}

const securedHandler = withSupabase({ auth: "publishable" }, async (req, ctx) => {
  try {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/api/optimize") || url.pathname.endsWith("/api/dataset/upload/batch")) {
      const request = req.method === "POST" ? await req.clone().json().catch(() => ({})) : {};
      if (url.pathname.endsWith("/api/optimize")) {
        // Per-isolate burst limit; query plans still have a strict database statement timeout.
        const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "shared";
        const now = Date.now(); const recent = (queryRate.get(forwarded) || []).filter((stamp) => now - stamp < 10 * 60_000);
        if (recent.length >= 30) return fail("Query limit reached. Please wait a few minutes before optimizing more SQL.", 429);
        recent.push(now); queryRate.set(forwarded, recent);
      }
      if (url.pathname.endsWith("/api/dataset/upload/batch") && JSON.stringify(request.rows || []).length > 1_300_000) {
        return fail("Upload batch is too large. Select fewer rows per batch.", 413);
      }
    }
    return await handle(req, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    const status = /timeout|statement timeout|canceling statement/i.test(message) ? 408 : 400;
    return fail(message, status);
  }
});

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  return securedHandler(req);
});

