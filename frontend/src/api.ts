const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const API_BASE = `${String(SUPABASE_URL || "").replace(/\/$/, "")}/functions/v1/queryopt-api`;

async function request<T>(path: string, init?: RequestInit, retry = false): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase API details are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY for this website.");
  }
  const headers = new Headers(init?.headers);
  headers.set("apikey", SUPABASE_KEY);
  if (!(init?.body instanceof FormData) && init?.body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new Error("Could not connect to QueryOpt AI. Check the internet connection and try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (retry && [429, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      return request<T>(path, init, false);
    }
    throw new Error(body.detail || `API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

const fileToTable: Record<string, string> = {
  "olist_customers_dataset.csv": "customers",
  "olist_orders_dataset.csv": "orders",
  "olist_order_items_dataset.csv": "order_items",
  "olist_products_dataset.csv": "products",
  "olist_order_payments_dataset.csv": "order_payments",
  "olist_order_reviews_dataset.csv": "order_reviews",
  "olist_sellers_dataset.csv": "sellers",
  "product_category_name_translation.csv": "product_category_name_translation",
  "olist_geolocation_dataset.csv": "geolocation",
};

const requiredColumns: Record<string, string[]> = {
  customers: ["customer_id", "customer_unique_id", "customer_zip_code_prefix", "customer_city", "customer_state"],
  orders: ["order_id", "customer_id", "order_status", "order_purchase_timestamp", "order_approved_at", "order_delivered_carrier_date", "order_delivered_customer_date", "order_estimated_delivery_date"],
  order_items: ["order_id", "order_item_id", "product_id", "seller_id", "shipping_limit_date", "price", "freight_value"],
  products: ["product_id", "product_category_name", "product_name_lenght", "product_description_lenght", "product_photos_qty", "product_weight_g", "product_length_cm", "product_height_cm", "product_width_cm"],
  order_payments: ["order_id", "payment_sequential", "payment_type", "payment_installments", "payment_value"],
  order_reviews: ["review_id", "order_id", "review_score", "review_comment_title", "review_comment_message", "review_creation_date", "review_answer_timestamp"],
  sellers: ["seller_id", "seller_zip_code_prefix", "seller_city", "seller_state"],
  product_category_name_translation: ["product_category_name", "product_category_name_english"],
  geolocation: ["geolocation_zip_code_prefix", "geolocation_lat", "geolocation_lng", "geolocation_city", "geolocation_state"],
};

const integerColumns = new Set(["customer_zip_code_prefix", "order_item_id", "product_name_lenght", "product_description_lenght", "product_photos_qty", "payment_sequential", "payment_installments", "review_score", "seller_zip_code_prefix", "geolocation_zip_code_prefix"]);
const numberColumns = new Set(["price", "freight_value", "payment_value", "product_weight_g", "product_length_cm", "product_height_cm", "product_width_cm", "geolocation_lat", "geolocation_lng"]);

function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"'; index++;
      } else if (quoted) {
        quoted = false;
      } else if (!field) {
        quoted = true;
      } else {
        throw new Error("This CSV has a quote in an unexpected place. Re-download it from Kaggle and try again.");
      }
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) yield row;
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("This CSV has an unfinished quoted field.");
  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell !== "")) yield row;
  }
}

function* csvBatches(text: string, table: string, size = 900): Generator<Record<string, unknown>[]> {
  const records = csvRows(text);
  const headerRow = records.next();
  if (headerRow.done) throw new Error("A selected CSV is empty.");
  const headers = headerRow.value.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  const required = requiredColumns[table];
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`The ${table} CSV is missing required columns: ${missing.join(", ")}.`);
  const accepted = new Set(required);
  let batch: Record<string, unknown>[] = [];
  let geolocationId = 0;
  for (const values of records) {
    if (values.length > headers.length) throw new Error(`The ${table} CSV contains a malformed row.`);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (!accepted.has(header)) return;
      const raw = (values[index] ?? "").trim();
      if (!raw) { row[header] = null; return; }
      if (integerColumns.has(header) || numberColumns.has(header)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`The ${table} CSV has an invalid number in ${header}.`);
        row[header] = value;
      } else {
        row[header] = raw;
      }
    });
    if (table === "geolocation") row.geolocation_id = ++geolocationId;
    batch.push(row);
    if (batch.length >= size) { yield batch; batch = []; }
  }
  if (batch.length) yield batch;
}

async function uploadFile(uploadId: string, file: File, table: string) {
  const text = await file.text();
  let pending: Promise<unknown>[] = [];
  let rows = 0;
  for (const batch of csvBatches(text, table)) {
    pending.push(request("/api/dataset/upload/batch", {
      method: "POST",
      body: JSON.stringify({ upload_id: uploadId, table, rows: batch }),
    }, true));
    rows += batch.length;
    if (pending.length === 3) {
      await Promise.all(pending);
      pending = [];
    }
  }
  if (pending.length) await Promise.all(pending);
  if (!rows) throw new Error(`${file.name} has a header but no data rows.`);
  return rows;
}

const starterQueries = [
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

async function importOlist(files: File[]) {
  const selected = new Map<string, File>();
  for (const file of files) {
    const filename = file.name.replaceAll("\\", "/").split("/").pop()?.toLowerCase() || "";
    if (!(filename in fileToTable)) throw new Error(`${filename || "A selected file"} is not one of the Olist Kaggle CSV files.`);
    if (selected.has(filename)) throw new Error(`${filename} was selected more than once.`);
    selected.set(filename, file);
  }
  const coreNames = ["olist_customers_dataset.csv", "olist_orders_dataset.csv", "olist_order_items_dataset.csv", "olist_products_dataset.csv"];
  const supplementalNames = ["olist_order_payments_dataset.csv", "olist_order_reviews_dataset.csv", "olist_sellers_dataset.csv", "product_category_name_translation.csv", "olist_geolocation_dataset.csv"];
  const hasCore = [...selected.keys()].some((filename) => coreNames.includes(filename));
  const hasSupplemental = [...selected.keys()].some((filename) => supplementalNames.includes(filename));
  if (!selected.size) throw new Error("Select the Olist CSV files shown on the Dataset page.");
  if (hasCore && hasSupplemental) throw new Error("Upload the four core CSV files first. Add the remaining Olist files in a second upload.");
  const kind = hasCore ? "core" : "supplemental";
  const orderedNames = kind === "core" ? coreNames : supplementalNames.filter((filename) => selected.has(filename));
  const required = kind === "core" ? coreNames : orderedNames;
  const missing = required.filter((filename) => !selected.has(filename));
  if (missing.length) throw new Error(kind === "core" ? `Select all four required Kaggle files: ${missing.join(", ")}.` : "Select at least one remaining Olist CSV file.");
  const filesToImport = orderedNames.filter((filename) => selected.has(filename)).map((filename) => [filename, selected.get(filename)!] as const);
  const totalSize = filesToImport.reduce((sum, [, file]) => sum + file.size, 0);
  if (totalSize > 100 * 1024 * 1024) throw new Error("The selected Olist CSV files exceed the 100 MB upload limit. Upload the core files first, then the remaining files.");
  const tables = kind === "core"
    ? ["customers", "orders", "order_items", "products"]
    : filesToImport.map(([filename]) => fileToTable[filename]);

  const started = await request<{ upload_id: string }>("/api/dataset/upload/start", {
    method: "POST", body: JSON.stringify({ kind, tables }),
  });
  const tableSizes: Record<string, number> = {};
  for (const [filename, file] of filesToImport) tableSizes[fileToTable[filename]] = await uploadFile(started.upload_id, file, fileToTable[filename]);
  const completed = await request<any>("/api/dataset/upload/complete", { method: "POST", body: JSON.stringify({ upload_id: started.upload_id }) });

  let benchmarkMeasurements = 0;
  const queriesToRun = kind === "core" ? starterQueries.slice(0, 5) : starterQueries.slice(5);
  for (const sql of queriesToRun) {
    try {
      const result = await request<any>("/api/optimize", { method: "POST", body: JSON.stringify({ sql, is_benchmark: true }) });
      benchmarkMeasurements += result.candidates?.length || 0;
    } catch {
      // Keep the successfully imported business records when a small free database times out on one benchmark.
    }
  }
  return {
    message: completed.message,
    dataset: completed.dataset,
    uploaded_table_sizes: completed.uploaded_table_sizes || tableSizes,
    benchmark_measurements_added: benchmarkMeasurements,
  };
}

export const api = {
  health: () => request<{ status: string; database: string }>("/health"),
  overview: () => request<any>("/api/overview"),
  dataset: () => request<any>("/api/dataset?limit=100"),
  history: () => request<{ items: any[]; count: number }>("/api/query-history?limit=100"),
  models: () => request<any>("/api/models"),
  examples: () => request<{ items: { id: string; sql: string }[] }>("/api/examples"),
  optimize: (sql: string) => request<any>("/api/optimize", { method: "POST", body: JSON.stringify({ sql }) }),
  uploadDataset: (files: File[]) => importOlist(files),
};

