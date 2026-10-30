# QueryOpt AI

This repository contains the QueryOpt AI website and API for the project synopsis, **Predictive Database Query Optimization Using Machine Learning**. The existing dark dashboard layout and navigation are retained. The application starts without business data and does not generate demo or synthetic rows.

## Selected source dataset

**Brazilian E-Commerce Public Dataset by Olist** on Kaggle:  
https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce

It contains anonymized historical Brazilian e-commerce orders from 2016–2018. It is a genuine public dataset, but it is not a real-time feed. Query plans and timings become live measurements when someone runs a query against the uploaded records.

Kaggle requires an account and authenticated download for this dataset. Download it from Kaggle and extract the archive. The four core CSV files are:

- `olist_customers_dataset.csv`
- `olist_orders_dataset.csv`
- `olist_order_items_dataset.csv`
- `olist_products_dataset.csv`

The website can then accept the five additional CSV files (geolocation, payments, reviews, sellers, and category translation) in a second upload. Keeping the two uploads separate stays within the 100 MB request limit. The source dataset's license is **CC BY-NC-SA 4.0** (attribution, non-commercial use, share-alike). See the Kaggle page for its attribution and license terms. Dataset files are not bundled in this repository.

## What the application does

- Imports all nine Olist CSV files into a shared PostgreSQL database after validating their names and columns; the five supplemental tables can be added after the core four.
- Shows imported order records, per-table row counts, and the Kaggle dataset source.
- Measures five starter SQL workload shapes against the uploaded records using PostgreSQL `EXPLAIN ANALYZE`.
- Compares PostgreSQL's default plan with three planner settings and records measured execution time, planner cost, rows, buffer counts, and plan JSON.
- Collects further measurements as queries are submitted from the Query Optimizer page.
- Trains and compares Linear Regression, Random Forest, and Gradient Boosting using the application's measured query data. It shows no model score until enough distinct query shapes have been measured.
- Does not claim performance gains in advance. Timings depend on the uploaded data, database cache, load, and hosting tier.

The query runner accepts one read-only `SELECT` query over the nine Olist tables. PostgreSQL's `EXPLAIN ANALYZE` executes the query, so candidate runs use a read-only transaction and a statement timeout. [PostgreSQL EXPLAIN documentation](https://www.postgresql.org/docs/current/sql-explain.html)

## Project structure

- `frontend/`: Vite + React website.
- `backend/`: FastAPI API, PostgreSQL schema, CSV importer, query measurement, and model evaluation.
- `render.yaml`: Render API and PostgreSQL blueprint.
- `frontend/vercel.json`: Vercel build settings.

## Deploy with GitHub, Render, and Vercel

Push the repository to GitHub, then connect that repository to both hosting services.

### Render

1. In Render, choose **New → Blueprint** and select this repository's `render.yaml`.
2. Render creates the API and PostgreSQL database. Wait for the API's `/health` route to return `status: ok`.
3. The included free database is suitable for short demos. Render free PostgreSQL databases expire after 30 days; select a persistent database plan for longer use.

### Vercel

1. Import the same GitHub repository in Vercel.
2. Set **Root Directory** to `frontend`.
3. Set `VITE_API_BASE_URL` to the deployed Render API URL, without a trailing slash.
4. Deploy. The API allows Vercel preview and production subdomains; use `CORS_ORIGINS` on Render for any custom frontend domain.

### Upload the dataset

1. Download **Brazilian E-Commerce Public Dataset by Olist** from the Kaggle page above and extract the ZIP.
2. Open the deployed website's **Dataset** page.
3. Choose the four core CSV files together and leave the page open while they import.
4. Choose the remaining five Olist CSV files and leave the page open while they import and are benchmarked.
5. Use **Query Optimizer** to submit a query. New plan measurements then appear in Dashboard, Performance, History, and Dataset.

The Kaggle API guide describes authenticated downloads: https://www.kaggle.com/docs/api

## Local development

1. Create a PostgreSQL database and set `DATABASE_URL` for the backend.
2. From `backend/`, install `requirements.txt` and run `uvicorn app.main:app --reload --port 8000`.
3. Set `VITE_API_BASE_URL=http://localhost:8000` in `frontend/.env.local`.
4. From `frontend/`, run `npm install` then `npm run dev`.

The API creates empty tables on startup. Upload the four core Kaggle CSV files from the Dataset screen, then add the remaining five files; there is no generated demo data.

## Original Bolt URL

The public URL `https://queryopt-ai-94rk.bolt.host/` does not provide access to the original Bolt source or its hosting account. This repository preserves the UI layout and deploys as a separate Vercel site, so it will have a new URL.


