# QueryOpt AI

**Predictive Database Query Optimization Using Machine Learning** keeps the existing QueryOpt AI dashboard UI and connects it to a shared Supabase PostgreSQL database.

## Production architecture

- `frontend/`: React + Vite dashboard, published on Lovable or Vercel.
- `supabase/functions/queryopt-api/`: Supabase Edge Function API. The browser sends the public publishable key; privileged database work stays in the Edge Function.
- `supabase/migrations/`: database tables, indexes, row-level security, import controls, and safe query-plan functions.
- Supabase PostgreSQL: shared storage for the Olist source tables and real query-plan measurements. Data remains available when another device opens the same site.

The existing FastAPI/Render files are kept for the original deployment path. The current Supabase-backed frontend uses the Edge Function and does not need a Render API URL.

## Dataset

The website uses the real **Brazilian E-Commerce Public Dataset by Olist** from Kaggle: [olistbr/brazilian-ecommerce](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce). Its records cover 2016–2018. This is historical data, not a live order feed. SQL plans, query execution times, and buffer reads are measured live against the shared PostgreSQL database.

Upload the four core CSV files together from the Dataset page:

- `olist_customers_dataset.csv`
- `olist_orders_dataset.csv`
- `olist_order_items_dataset.csv`
- `olist_products_dataset.csv`

Then upload any or all remaining five CSV files as a second batch:

- `olist_order_payments_dataset.csv`
- `olist_order_reviews_dataset.csv`
- `olist_sellers_dataset.csv`
- `product_category_name_translation.csv`
- `olist_geolocation_dataset.csv`

The second upload keeps the large geolocation file within the site's 100 MB per-upload limit. Imported files are stored in Supabase, not in the browser, so other devices see the same data. The Kaggle dataset license is **CC BY-NC-SA 4.0**; follow its attribution, non-commercial, and share-alike terms.

## Query analysis and ML

1. The user submits one `SELECT` query against the Olist tables.
2. The API checks the query and measures four PostgreSQL planner settings with `EXPLAIN ANALYZE` and buffer statistics.
3. It saves each plan, actual runtime, estimated cost, row count, and query features in `query_measurements`.
4. Linear Regression, Decision Tree, Random Forest, and Gradient Boosting are compared using validation grouped by query shape. They stay in warm-up until there are enough real measurements.
5. Once trained, the Random Forest predicts each candidate's runtime and recommends one plan. During warm-up, PostgreSQL's default plan remains the recommendation.

Query execution is read-only, limited to Olist tables and approved SQL functions, and protected by a database statement timeout. Timings vary with cache, concurrent load, and the Supabase plan. The application does not claim an improvement before it has measurements.

## Deploy the frontend

The Supabase project schema and `queryopt-api` Edge Function are deployed separately through Supabase. The frontend's public production settings are in `frontend/.env.production`; the key there is a publishable browser key, not a secret server key.

For Vercel, import this repository, set **Root Directory** to `frontend`, and deploy with the included Vite configuration. For Lovable, connect the project to this repository and publish after the GitHub changes sync. The existing visual dashboard and navigation stay in place.

## Local development

1. Copy the two `VITE_SUPABASE_*` values from `frontend/.env.production` into `frontend/.env.local`.
2. From `frontend/`, run `npm install` and `npm run dev`.

Do not put the Supabase secret/service-role key in the frontend or commit it to GitHub. The Edge Function uses its server-side Supabase credentials.

