import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, Brain, Braces, ChartColumn, Check, CircleDot, Clock3, CodeXml, Cpu,
  Database, FileCode2, GitBranch, Info, LayoutDashboard, LoaderCircle, Play,
  Search, Server, SlidersHorizontal, Sparkles, Trophy, Trash2, Upload, X,
} from "lucide-react";
import { api } from "./api";

type Page = "Dashboard" | "Query Optimizer" | "Execution Plans" | "ML Models" | "Performance" | "History" | "Dataset" | "About Project";
type Measurement = Record<string, any>;

const navItems: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Query Optimizer", icon: CodeXml },
  { label: "Execution Plans", icon: GitBranch },
  { label: "ML Models", icon: Brain },
  { label: "Performance", icon: ChartColumn },
  { label: "History", icon: Clock3 },
  { label: "Dataset", icon: Database },
  { label: "About Project", icon: Info },
];

const examples = [
  { name: "Simple Filter", sql: "SELECT * FROM customers WHERE customer_state = 'SP' LIMIT 50;" },
  { name: "Customer Orders", sql: "SELECT c.customer_id, c.customer_state, o.order_id, o.order_status FROM customers c JOIN orders o ON c.customer_id = o.customer_id LIMIT 50;" },
  { name: "Aggregation", sql: "SELECT order_status, COUNT(*) AS order_count FROM orders GROUP BY order_status;" },
  { name: "Multi Join", sql: "SELECT c.customer_state, p.product_category_name, i.price FROM customers c JOIN orders o ON c.customer_id = o.customer_id JOIN order_items i ON o.order_id = i.order_id JOIN products p ON i.product_id = p.product_id LIMIT 100;" },
  { name: "Analytical Query", sql: "SELECT c.customer_state, COUNT(DISTINCT o.order_id) AS order_count, SUM(i.price + i.freight_value) AS gross_value FROM customers c JOIN orders o ON c.customer_id = o.customer_id JOIN order_items i ON o.order_id = i.order_id GROUP BY c.customer_state ORDER BY gross_value DESC;" },
];

const fmt = (value: unknown, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const relative = (value?: string) => value ? new Date(value).toLocaleString() : "—";

function groupRuns(rows: Measurement[]) {
  const groups = new Map<string, Measurement[]>();
  for (const item of rows) {
    const key = item.run_id || item.query_key || String(item.id);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups.entries()].map(([runId, candidates]) => {
    const baseline = candidates.find((item) => item.strategy === "planner_default");
    const predicted = candidates.filter((item) => typeof item.predicted_ms === "number").sort((a, b) => a.predicted_ms - b.predicted_ms)[0];
    const recommended = predicted || baseline || candidates[0];
    const fastest = [...candidates].sort((a, b) => a.execution_ms - b.execution_ms)[0];
    const improvement = baseline?.execution_ms ? ((baseline.execution_ms - recommended.execution_ms) / baseline.execution_ms) * 100 : 0;
    return { runId, candidates, baseline, recommended, fastest, improvement, query: candidates[0]?.query || "", time: candidates[0]?.measured_at };
  }).sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function PanelHeading({ title, icon: Icon, aside }: { title: string; icon?: typeof Database; aside?: React.ReactNode }) {
  return <div className="panel-heading"><div className="panel-title">{Icon && <Icon size={16} />}<h3>{title}</h3></div>{aside}</div>;
}

function MetricCard({ icon: Icon, label, value, caption, accent = "blue" }: { icon: typeof Cpu; label: string; value: string; caption?: string; accent?: string }) {
  return <Card className="metric-card"><div className={`metric-icon ${accent}`}><Icon size={18} /></div><div><div className="eyebrow">{label}</div><div className="metric-value">{value}</div><div className="muted small">{caption}</div></div></Card>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state"><Database size={24} /><span>{children}</span></div>;
}

function BarChart({ rows, leftKey, rightKey, labelKey, leftLabel, rightLabel, unit = "ms" }: {
  rows: any[]; leftKey: string; rightKey: string; labelKey: string; leftLabel: string; rightLabel: string; unit?: string;
}) {
  if (!rows.length) return <Empty>Run a query to start collecting live chart data.</Empty>;
  const max = Math.max(1, ...rows.flatMap((row) => [Number(row[leftKey] || 0), Number(row[rightKey] || 0)]));
  return <div className="chart-bars">{rows.slice(0, 7).map((row, i) => <div className="chart-group" key={`${row[labelKey]}-${i}`}>
    <div className="bar-pair"><div className="bar-track"><div className="bar actual" style={{ width: `${Math.max(3, Number(row[leftKey] || 0) / max * 100)}%` }} title={`${fmt(row[leftKey)} ${unit}`} /></div><div className="bar-track"><div className="bar predicted" style={{ width: `${Math.max(3, Number(row[rightKey] || 0) / max * 100)}%` }} title={`${fmt(row[rightKey)} ${unit}`} /></div></div>
    <span className="chart-label">{row[labelKey]}</span></div>)}</div>;
}

function App() {
  const [page, setPage] = useState<Page>("Dashboard");
  const [presentation, setPresentation] = useState(false);
  const [online, setOnline] = useState(false);
  const [apiError, setApiError] = useState("");
  const [overview, setOverview] = useState<any>(null);
  const [dataset, setDataset] = useState<any>(null);
  const [history, setHistory] = useState<Measurement[]>([]);
  const [models, setModels] = useState<any>(null);
  const [sql, setSql] = useState(examples[4].sql);
  const [result, setResult] = useState<any>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [complexity, setComplexity] = useState("All Complexity");
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const runs = useMemo(() => groupRuns(history), [history]);

  const refresh = useCallback(async () => {
    try {
      const health = await api.health();
      setOnline(health.status === "ok");
      const [nextOverview, nextDataset, nextHistory, nextModels] = await Promise.all([
        api.overview(), api.dataset(), api.history(), api.models(),
      ]);
      setOverview(nextOverview); setDataset(nextDataset); setHistory(nextHistory.items); setModels(nextModels); setApiError("");
    } catch (error) {
      setOnline(false);
      setApiError(error instanceof Error ? error.message : "Could not reach the API");
    }
  }, []);

  const uploadOlistDataset = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true); setUploadMessage(""); setUploadError("");
    try {
      const result = await api.uploadDataset(Array.from(files));
      setUploadMessage(`${result.message} Imported rows are now available for query analysis.`);
      await refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Dataset upload failed");
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 20000); return () => window.clearInterval(timer); }, [refresh]);

  const optimize = async () => {
    setOptimizing(true); setResult(null);
    try {
      const next = await api.optimize(sql);
      setResult(next); await refresh();
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Query could not be analyzed" });
    } finally { setOptimizing(false); }
  };

  const pageTitle = page === "Performance" ? "Performance Comparison" : page;
  const renderPage = () => {
    switch (page) {
      case "Dashboard": return <Dashboard overview={overview} history={runs} models={models} dataset={dataset} />;
      case "Query Optimizer": return <QueryOptimizer sql={sql} setSql={setSql} optimizing={optimizing} result={result} onOptimize={optimize} datasetLoaded={Boolean(dataset?.dataset_loaded)} />;
      case "Execution Plans": return <ExecutionPlans result={result} history={runs} />;
      case "ML Models": return <ModelsPage models={models} datasetLoaded={Boolean(dataset?.dataset_loaded)} />;
      case "Performance": return <PerformancePage history={runs} datasetLoaded={Boolean(dataset?.dataset_loaded)} />;
      case "History": return <HistoryPage history={runs} searchTerm={searchTerm} setSearchTerm={setSearchTerm} complexity={complexity} setComplexity={setComplexity} />;
      case "Dataset": return <DatasetPage dataset={dataset} onUpload={uploadOlistDataset} uploading={uploading} uploadMessage={uploadMessage} uploadError={uploadError} />;
      case "About Project": return <AboutPage />;
    }
  };

  return <div className={`app-shell ${presentation ? "presentation-mode" : ""}`}>
    {!presentation && <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Activity size={20} /></span><span><b>QueryOpt AI</b><small>Predictive Query Optimization</small></span></div>
      <nav className="side-nav">{navItems.map(({ label, icon: Icon }) => <button className={`nav-button ${page === label ? "active" : ""}`} key={label} onClick={() => setPage(label)}><Icon size={16} /><span>{label}</span></button>)}
        <button className="nav-button presentation-link" onClick={() => setPresentation(true)}><CircleDot size={16} /><span>Presentation Mode</span></button>
      </nav>
      <div className="system-status"><div className="status-title">System Status</div><StatusLine label="Backend" value={online ? "ONLINE" : "OFFLINE"} online={online} /><StatusLine label="Optimizer" value={online ? "READY" : "WAITING"} online={online} /><StatusLine label="ML Model" value={models?.status === "evaluated" ? "READY" : "WARMING UP"} online={models?.status === "evaluated"} /><div className="mode-line"><span>Mode</span><b>{online ? "LIVE POSTGRESQL" : "CONNECTING"}</b></div></div>
    </aside>}
    <main className="main-shell"><header className="mobile-header"><div className="brand compact"><span className="brand-icon"><Activity size={18} /></span><b>QueryOpt AI</b></div><span className={`live-pill ${online ? "" : "offline"}`}><i />{online ? "LIVE" : "OFFLINE"}</span></header>
      {presentation && <button className="presentation-exit" onClick={() => setPresentation(false)}><X size={14} /> Exit presentation</button>}
      <div className="page-content"><div className="page-topline"><div><h1>{pageTitle === "Dashboard" ? "Predictive Database Query Optimization" : pageTitle}</h1><p>{pageSubtitle(page)}</p></div><span className={`connection-pill ${online ? "" : "offline"}`}><i />{online ? "PostgreSQL connected" : "Waiting for backend"}</span></div>
        {apiError && <div className="api-alert"><Server size={15} /><span>{apiError}. Set <code>VITE_API_BASE_URL</code> to the Render API URL.</span></div>}
        {renderPage()}
      </div>
    </main>
  </div>;
}

function pageSubtitle(page: Page) {
  const subtitles: Record<Page, string> = {
    "Dashboard": "Use Machine Learning to predict query execution performance and recommend efficient execution plans.",
    "Query Optimizer": "Enter a read-only SQL query and let QueryOpt AI compare candidate execution plans.",
    "Execution Plans": "View and compare candidate execution plans from the last optimization.",
    "ML Models": "Compare the three machine learning models used for execution time prediction.",
    "Performance": "Compare PostgreSQL's default plan with the ML-assisted recommendation.",
    "History": "All optimization results recorded in PostgreSQL.",
    "Dataset": "Upload the real Olist source files and inspect the records and measured query features.",
    "About Project": "ML-Assisted PostgreSQL Query Plan Recommendation — Academic Prototype",
  };
  return subtitles[page];
}

function StatusLine({ label, value, online }: { label: string; value: string; online: boolean }) {
  return <div className="status-line"><span>{label}</span><b className={online ? "" : "muted-status"}><i />{value}</b></div>;
}

function Dashboard({ overview, history, models, dataset }: { overview: any; history: any[]; models: any; dataset: any }) {
  const hasDataset = Boolean(dataset?.dataset_loaded);
  const comparisons = history.slice(0, 6).map((run, i) => ({ query: `Q${String(i + 1).padStart(3, "0")}`, baseline: run.baseline?.execution_ms, recommended: run.recommended?.execution_ms }));
  const planCounts = (dataset?.items || []).reduce((acc: Record<string, number>, item: any) => { acc[item.plan_type] = (acc[item.plan_type] || 0) + 1; return acc; }, {});
  const totalRuns = dataset?.live_query_run_count ?? new Set((dataset?.items || []).filter((item: any) => !item.is_benchmark).map((item: any) => item.run_id)).size;
  const randomForest = models?.items?.find((item: any) => item.model === "Random Forest");
  const trained = models?.status === "evaluated";
  const avgTime = history.length ? history.reduce((sum, run) => sum + Number(run.recommended?.execution_ms || 0), 0) / history.length : null;
  const avgImprovement = history.length ? history.reduce((sum, run) => sum + run.improvement, 0) / history.length : null;
  return <>
    <div className="prototype-banner"><span className="live-dot" />{hasDataset ? "Olist dataset loaded" : "Waiting for dataset upload"}<span className="banner-divider">·</span>{dataset?.measurement_count ?? 0} measured plan records <span className="banner-note">{hasDataset ? "Query timings are measured live by PostgreSQL." : "Open Dataset to upload the four Kaggle CSV files."}</span></div>
    <div className="metrics-grid">
      <MetricCard icon={Database} label="Total Queries Optimized" value={String(totalRuns)} caption="Live query runs" />
      <MetricCard icon={Trophy} label="Best ML Model" value={trained ? models.best_model : hasDataset ? "Warming up" : "Awaiting data"} caption={trained ? `RMSE ${fmt(randomForest?.rmse, 3)} ms` : `${models?.query_shapes || 0} query shapes observed`} accent="green" />
      <MetricCard icon={Activity} label="Avg Measured Time" value={avgTime === null ? "—" : `${fmt(avgTime, 2)} ms`} caption="Across recent recommendations" accent="cyan" />
      <MetricCard icon={ChartColumn} label="Avg Improvement" value={avgImprovement === null ? "—" : `${fmt(avgImprovement, 1)}%`} caption="vs PostgreSQL default, measured" accent="purple" />
      <MetricCard icon={GitBranch} label="Candidate Plans Tested" value={String(overview?.measurements?.total ?? 0)} caption="4 planner configurations per query" accent="blue" />
      <MetricCard icon={Brain} label="Model R²" value={trained && randomForest?.r2 !== null ? fmt(randomForest?.r2, 3) : "—"} caption={trained ? "Held-out query shapes" : "Shown after enough live samples"} accent="amber" />
    </div>
    <div className="dashboard-charts">
      <Card><PanelHeading title="Traditional vs ML-Assisted Execution Time" /><Legend items={[["actual", "Traditional"], ["predicted", "ML-Assisted"]]} /><BarChart rows={comparisons} labelKey="query" leftKey="baseline" rightKey="recommended" leftLabel="Traditional" rightLabel="ML-Assisted" /></Card>
      <Card><PanelHeading title="ML Model Comparison (RMSE)" /><Legend items={[["actual", "MAE"], ["predicted", "RMSE"]]} /><MetricBars items={models?.items || []} label="model" left="mae" right="rmse" /></Card>
      <Card><PanelHeading title="Query Performance Trend" /><Legend items={[["actual", "Actual"], ["predicted", "Predicted"]]} /><BarChart rows={history.slice(0, 7).map((run, i) => ({ id: `#${i + 1}`, actual: run.recommended?.execution_ms, predicted: run.recommended?.predicted_ms }))} labelKey="id" leftKey="actual" rightKey="predicted" leftLabel="Actual" rightLabel="Predicted" /></Card>
      <Card><PanelHeading title="Execution Plan Distribution" /><PlanDistribution counts={planCounts} /></Card>
    </div>
    <Card><PanelHeading title="Recent Optimizations" aside={<span className="subtle-count">{history.length} entries</span>} />{history.length ? <RecentRuns runs={history.slice(0, 6)} /> : <Empty>Run a query in Query Optimizer to see live results here.</Empty>}</Card>
  </>;
}

function Legend({ items }: { items: [string, string][] }) {
  return <div className="legend">{items.map(([color, label]) => <span key={label}><i className={color} />{label}</span>)}</div>;
}

function MetricBars({ items, label, left, right }: { items: any[]; label: string; left: string; right: string }) {
  if (!items.length) return <Empty>Model comparison starts after enough query shapes are collected.</Empty>;
  const max = Math.max(0.001, ...items.flatMap((item) => [item[left] || 0, item[right] || 0]));
  return <div className="model-bars">{items.map((item) => <div className="model-bar-row" key={item.model}><span>{item.model.replace(" Regression", "")}</span><div className="model-bar-stack"><i className="actual" style={{ width: `${Math.max(3, item[left] / max * 100)}%` }} /><i className="predicted" style={{ width: `${Math.max(3, item[right] / max * 100)}%` }} /></div><small>{fmt(item[right], 2)}</small></div>)}</div>;
}

function PlanDistribution({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).slice(0, 7);
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  if (!entries.length) return <Empty>Plan nodes appear after the first measured query.</Empty>;
  return <div className="distribution">{entries.map(([name, value], i) => <div className="distribution-row" key={name}><span className={`plan-chip c${i % 5}`} /> <span>{name}</span><div className="distribution-track"><i style={{ width: `${value / total * 100}%` }} /></div><b>{value}</b></div>)}</div>;
}

function RecentRuns({ runs }: { runs: any[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Query</th><th>Default</th><th>Recommended</th><th>Improvement</th><th>Selected Plan</th><th>Measured</th></tr></thead><tbody>{runs.map((run) => <tr key={run.runId}><td className="query-cell">{run.query.slice(0, 74)}{run.query.length > 74 ? "…" : ""}</td><td>{fmt(run.baseline?.execution_ms, 2)} ms</td><td>{fmt(run.recommended?.execution_ms, 2)} ms</td><td className={run.improvement >= 0 ? "good" : "warn"}>{fmt(run.improvement, 1)}%</td><td><span className="table-badge">{run.recommended?.strategy || "—"}</span></td><td>{relative(run.time)}</td></tr>)}</tbody></table></div>;
}

function QueryOptimizer({ sql, setSql, optimizing, result, onOptimize, datasetLoaded }: { sql: string; setSql: (v: string) => void; optimizing: boolean; result: any; onOptimize: () => void; datasetLoaded: boolean }) {
  const [exampleIndex, setExampleIndex] = useState(0);
  return <>
    <div className="example-list">{examples.map((example, index) => <button className="example-chip" key={example.name} onClick={() => { setSql(example.sql); setExampleIndex(index); }}>{example.name}</button>)}</div>
    <Card className="sql-card"><div className="sql-heading"><div className="panel-title"><FileCode2 size={16} /><b>SQL Editor</b><span className="read-only-badge">Read-Only</span></div><span className="muted">PostgreSQL Syntax</span></div><textarea aria-label="Enter your SELECT query here..." value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} /><div className="sql-footer"><div className="sql-hint">{result?.error ? <span className="error-text">{result.error}</span> : datasetLoaded ? <>PostgreSQL live mode · one SELECT · uploaded Olist tables only</> : <>Upload the Olist CSV files from Dataset before measuring a query.</>}</div><div className="sql-actions"><button className="secondary-button" onClick={() => { setSql(examples[exampleIndex].sql); }}><Braces size={14} />Load Example</button><button className="secondary-button" onClick={() => setSql("")}><Trash2 size={14} />Clear</button><button className="primary-button" onClick={onOptimize} disabled={!datasetLoaded || optimizing || !sql.trim()}>{optimizing ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{optimizing ? "Measuring plans…" : "Optimize Query"}</button></div></div></Card>
    {result && !result.error && <OptimizationResult result={result} />}
  </>;
}

function OptimizationResult({ result }: { result: any }) {
  const defaultMs = result.default_execution_ms;
  const chosenMs = result.recommended_execution_ms;
  const delta = defaultMs ? ((defaultMs - chosenMs) / defaultMs) * 100 : 0;
  return <div className="results-stack"><Card><div className="result-heading"><div><span className="success-kicker"><Check size={14} />Query measured</span><h2>Plan recommendation</h2></div><span className="table-badge">{result.recommended_strategy}</span></div><div className="result-metrics"><div><span>PostgreSQL default</span><b>{fmt(defaultMs, 3)} ms</b></div><div><span>Recommended actual</span><b>{fmt(chosenMs, 3)} ms</b></div><div><span>Observed change</span><b className={delta >= 0 ? "good" : "warn"}>{fmt(delta, 1)}%</b></div><div><span>ML selection</span><b>{result.selection_source === "random_forest" ? `Predicted ${fmt(result.predicted_execution_ms, 3)} ms` : "Warming up · measured default"}</b></div></div><p className="subtle-note">{result.note}</p></Card>
    <Card><PanelHeading title="Candidate Plan Comparison" /><div className="table-wrap"><table><thead><tr><th>Strategy</th><th>Predicted</th><th>Actual</th><th>Estimated Cost</th><th>Rows</th><th>Buffer Hits</th></tr></thead><tbody>{result.candidates.map((candidate: any) => <tr key={candidate.strategy} className={candidate.strategy === result.recommended_strategy ? "selected-row" : ""}><td>{candidate.strategy === result.recommended_strategy && <Check size={13} className="inline-good" />} {candidate.strategy}</td><td>{fmt(candidate.predicted_execution_ms, 3)} ms</td><td>{fmt(candidate.execution_ms, 3)} ms</td><td>{fmt(candidate.estimated_cost, 1)}</td><td>{candidate.actual_rows}</td><td>{candidate.shared_hit_blocks}</td></tr>)}</tbody></table></div></Card>
    <div className="result-columns"><Card><PanelHeading title="Selected Execution Plan" icon={GitBranch} /><PlanTree nodes={result.plan || []} /></Card><Card><PanelHeading title="Result Preview" icon={Database} /><Preview rows={result.result_preview || []} /></Card></div>
    </div>;
}

function PlanTree({ nodes }: { nodes: any[] }) {
  if (!nodes.length) return <Empty>No plan returned.</Empty>;
  return <div className="plan-tree">{nodes.map((node, index) => <div key={`${node.node_type}-${index}`} className="plan-node" style={{ marginLeft: `${Math.min(node.depth || 0, 5) * 18}px` }}><GitBranch size={14} /><div><b>{node.node_type}</b>{node.relation && <span> on {node.relation}</span>}<small>Rows {node.actual_rows ?? "—"} / estimate {node.estimated_rows ?? "—"} · {fmt(node.actual_time_ms, 3)} ms</small></div></div>)}</div>;
}

function Preview({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty>No rows returned for preview.</Empty>;
  const columns = Object.keys(rows[0]);
  return <div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.slice(0, 8).map((row, i) => <tr key={i}>{columns.map((column) => <td key={column}>{String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}

function ExecutionPlans({ result, history }: { result: any; history: any[] }) {
  if (result && !result.error) return <div className="results-stack"><Card><PanelHeading title="Latest Candidate Plans" aside={<span className="table-badge">{result.query_key.slice(0, 10)}</span>} /><div className="table-wrap"><table><thead><tr><th>Strategy</th><th>Execution Time</th><th>Estimated Cost</th><th>Plan Nodes</th></tr></thead><tbody>{result.candidates.map((item: any) => <tr key={item.strategy} className={item.strategy === result.recommended_strategy ? "selected-row" : ""}><td>{item.strategy}</td><td>{fmt(item.execution_ms, 3)} ms</td><td>{fmt(item.estimated_cost, 1)}</td><td>{item.plan.length}</td></tr>)}</tbody></table></div></Card><Card><PanelHeading title="Recommended Plan Tree" icon={GitBranch} /><PlanTree nodes={result.plan || []} /></Card></div>;
  if (!history.length) return <Card><Empty>Run a query in Query Optimizer to generate candidate plans from PostgreSQL.</Empty></Card>;
  return <Card><PanelHeading title="Latest Execution Plan Runs" /><RecentRuns runs={history.slice(0, 12)} /></Card>;
}

function ModelsPage({ models, datasetLoaded }: { models: any; datasetLoaded: boolean }) {
  if (!datasetLoaded) return <Card><PanelHeading title="Model Evaluation" icon={Brain} /><Empty>Upload the Olist CSV files from Dataset before collecting model observations.</Empty></Card>;
  if (!models || models.status === "warming_up") return <Card><PanelHeading title="Model Evaluation" icon={Brain} /><div className="warmup"><LoaderCircle size={20} /><div><b>Collecting measured query shapes</b><p>{models?.samples ?? 0} observations across {models?.query_shapes ?? 0} query shapes. Model scores appear after at least 4 distinct shapes.</p></div></div></Card>;
  return <><div className="prototype-banner"><Brain size={15} />Validation: {models.validation} <span className="banner-divider">·</span>{models.samples} measured candidates across {models.query_shapes} query shapes</div><div className="model-card-grid">{models.items.map((item: any) => <Card key={item.model} className="model-card"><div className="model-card-top"><div className="metric-icon blue"><Brain size={17} /></div>{item.model === models.best_model && <span className="best-badge">Best Performer</span>}</div><h2>{item.model}</h2><p className="muted">Held-out query-shape predictions, compared with measured PostgreSQL time.</p><div className="model-stats"><MetricValue label="MAE" value={fmt(item.mae, 3)} /><MetricValue label="MSE" value={fmt(item.mse, 4)} /><MetricValue label="RMSE" value={fmt(item.rmse, 3)} /><MetricValue label="R²" value={fmt(item.r2, 3)} /></div></Card>)}</div><div className="model-charts"><Card><PanelHeading title="RMSE Comparison" /><MetricBars items={models.items} label="model" left="mae" right="rmse" /></Card><Card><PanelHeading title="MAE Comparison" /><MetricBars items={models.items} label="model" left="mae" right="rmse" /></Card></div><Card className="note-card"><Info size={16} /><span>{models.note}</span></Card></>;
}

function MetricValue({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><b>{value}</b></div>; }

function PerformancePage({ history, datasetLoaded }: { history: any[]; datasetLoaded: boolean }) {
  const baseline = history.filter((run) => run.baseline).map((run) => run.baseline.execution_ms);
  const recommended = history.filter((run) => run.recommended).map((run) => run.recommended.execution_ms);
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const improvement = history.length ? avg(history.map((run) => run.improvement)) : 0;
  const chartRows = history.slice(0, 6).map((run, i) => ({ query: `Q${i + 1}`, traditional: run.baseline?.execution_ms, assisted: run.recommended?.execution_ms }));
  return <><div className="performance-banner"><Activity size={16} />{datasetLoaded ? "Measured against uploaded Olist records" : "Upload Olist data to start performance measurements"}</div><div className="performance-grid"><MetricCard icon={Server} label="Avg Traditional Time" value={history.length ? `${fmt(avg(baseline), 2)} ms` : "—"} caption="PostgreSQL default planner" /><MetricCard icon={Brain} label="Avg ML Recommended" value={history.length ? `${fmt(avg(recommended), 2)} ms` : "—"} caption="Measured selected plan" accent="green" /><MetricCard icon={ChartColumn} label="Avg Improvement" value={history.length ? `${fmt(improvement, 1)}%` : "—"} caption="Recommendation vs default" accent="cyan" /></div><div className="model-charts"><Card><PanelHeading title="Execution Time Comparison" /><Legend items={[["actual", "Traditional"], ["predicted", "ML-Assisted"]]} /><BarChart rows={chartRows} labelKey="query" leftKey="traditional" rightKey="assisted" leftLabel="Traditional" rightLabel="ML-Assisted" /></Card><Card><PanelHeading title="Performance Details" />{history.length ? <RecentRuns runs={history.slice(0, 8)} /> : <Empty>Run a query after upload to see measured performance.</Empty>}</Card></div></>;
}

function HistoryPage({ history, searchTerm, setSearchTerm, complexity, setComplexity }: { history: any[]; searchTerm: string; setSearchTerm: (s: string) => void; complexity: string; setComplexity: (s: string) => void }) {
  const filtered = history.filter((run) => {
    const sql = String(run.query || "").toLowerCase();
    const queryComplexity = (sql.match(/\bjoin\b/g) || []).length > 1 ? "High" : (sql.match(/\bjoin\b/g) || []).length || sql.includes("group by") ? "Medium" : "Low";
    return `${sql} ${run.recommended?.strategy}`.includes(searchTerm.toLowerCase()) && (complexity === "All Complexity" || complexity === queryComplexity);
  });
  return <Card><div className="history-filters"><label className="search-field"><Search size={15} /><input placeholder="Search queries, plans, models..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></label><label className="select-field"><SlidersHorizontal size={14} /><select value={complexity} onChange={(e) => setComplexity(e.target.value)}><option>All Complexity</option><option>Low</option><option>Medium</option><option>High</option></select></label></div><div className="subtle-count">{filtered.length} results</div>{filtered.length ? <RecentRuns runs={filtered.slice(0, 30)} /> : <Empty>No optimization history yet. Run a query in Query Optimizer to start building history.</Empty>}</Card>;
}

function DatasetPage({ dataset, onUpload, uploading, uploadMessage, uploadError }: { dataset: any; onUpload: (files: FileList | null) => void; uploading: boolean; uploadMessage: string; uploadError: string }) {
  const features = ["query_type", "num_tables", "num_joins", "num_filters", "num_aggregations", "plan_type", "scan_type", "join_type", "estimated_cost", "estimated_rows", "plan_depth", "num_nodes", "predicted_time", "actual_time"];
  const measurementColumns = ["query_id", "query_type", "num_tables", "num_joins", "num_filters", "num_aggregations", "plan_type", "scan_type", "join_type", "estimated_cost", "estimated_rows", "plan_depth", "num_nodes", "predicted_time", "actual_time"];
  const businessColumns = ["order_id", "customer_id", "order_status", "order_purchase_timestamp", "order_estimated_delivery_date"];
  const businessRows = Object.values(dataset?.table_sizes || {}).reduce((sum: number, count: any) => sum + Number(count || 0), 0);
  const loaded = Boolean(dataset?.dataset_loaded);
  return <>
    <div className="metrics-grid dataset-metrics">
      <MetricCard icon={Database} label="Dataset Size" value={String(businessRows)} caption="Imported Olist source rows" />
      <MetricCard icon={SlidersHorizontal} label="Feature Count" value={String(dataset?.feature_count ?? 14)} caption="Measured query and plan fields" accent="cyan" />
      <MetricCard icon={Activity} label="Query Measurements" value={String(dataset?.measurement_count ?? 0)} caption="Live PostgreSQL plan records" accent="purple" />
    </div>
    <Card>
      <div className="dataset-source">
        <div className="source-icon"><Database size={18} /></div>
        <div><b>Dataset source</b><p><a href={dataset?.source || "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce"} target="_blank" rel="noreferrer">{dataset?.dataset_name || "Brazilian E-Commerce Public Dataset by Olist"}</a></p><small>Historical anonymized e-commerce orders · License: {dataset?.license || "CC BY-NC-SA 4.0"}</small></div>
        <span className={`source-live ${loaded ? "" : "pending"}`}><i />{loaded ? "Loaded" : "Upload needed"}</span>
      </div>
      <div className="dataset-counts"><span>Customers {dataset?.table_sizes?.customers ?? 0}</span><span>Orders {dataset?.table_sizes?.orders ?? 0}</span><span>Order items {dataset?.table_sizes?.order_items ?? 0}</span><span>Products {dataset?.table_sizes?.products ?? 0}</span><span>Uploaded {relative(dataset?.uploaded_at)}</span></div>
    </Card>
    <Card>
      <PanelHeading title="Load the Kaggle CSV files" icon={Upload} />
      <p className="upload-note">Download <b>Brazilian E-Commerce Public Dataset by Olist</b> from Kaggle, then select these four files together. You can leave the other Kaggle files unselected.</p>
      <div className="upload-row">
        {loaded ? <span className="muted">Dataset loaded successfully. This database accepts one initial dataset upload.</span> : <label className={`primary-button dataset-upload-button ${uploading ? "is-loading" : ""}`} htmlFor="olist-files"><Upload size={14} />{uploading ? "Uploading and measuring…" : "Choose CSV files"}<input id="olist-files" className="file-input" type="file" accept=".csv,text/csv" multiple disabled={uploading} onChange={(event) => { onUpload(event.target.files); event.currentTarget.value = ""; }} /></label>}
        <span className="upload-size">Maximum combined upload: 100 MB</span>
      </div>
      <div className="required-files">{(dataset?.upload_required_files || ["olist_customers_dataset.csv", "olist_orders_dataset.csv", "olist_order_items_dataset.csv", "olist_products_dataset.csv"]).map((name: string) => <code key={name}>{name}</code>)}</div>
      {uploading && <p className="upload-status">Importing source rows, updating PostgreSQL statistics, and measuring the initial SQL workload. Keep this page open.</p>}
      {uploadMessage && <p className="upload-status success-text">{uploadMessage}</p>}
      {uploadError && <p className="upload-status error-text">{uploadError}</p>}
    </Card>
    <Card>
      <PanelHeading title="Imported Orders Preview" aside={<span className="subtle-count">real source rows</span>} />
      {dataset?.business_preview?.length ? <div className="table-wrap"><table className="dataset-table"><thead><tr>{businessColumns.map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{dataset.business_preview.map((row: any) => <tr key={row.order_id}>{businessColumns.map((name) => <td key={name}>{row[name] ?? "—"}</td>)}</tr>)}</tbody></table></div> : <Empty>Upload the Olist CSV files to preview real order records.</Empty>}
    </Card>
    <Card>
      <PanelHeading title="Query Measurement Preview" aside={<span className="subtle-count">latest {dataset?.items?.length ?? 0} measurements</span>} />
      {dataset?.items?.length ? <div className="table-wrap"><table className="dataset-table"><thead><tr>{measurementColumns.map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{dataset.items.map((row: any) => <tr key={row.query_id}>{measurementColumns.map((name) => <td key={name}>{row[name] == null ? "—" : typeof row[name] === "number" ? fmt(row[name], name.includes("time") ? 3 : 1) : row[name]}</td>)}</tr>)}</tbody></table></div> : <Empty>{loaded ? "Run a query in Query Optimizer to collect measured plan features." : "Measurements appear after the source dataset is uploaded."}</Empty>}
    </Card>
    <Card><PanelHeading title="Measured Feature Descriptions" /><div className="feature-list">{features.map((feature) => <div key={feature}><code>{feature}</code><span>{featureDescription(feature)}</span></div>)}</div></Card>
    <Card className="note-card"><Info size={16} /><span>{dataset?.notes || "Query plans, costs, buffers, and execution times are measured from PostgreSQL after upload."}</span></Card>
  </>;
}

function featureDescription(feature: string) {
  const descriptions: Record<string, string> = { query_type: "Categorization of the SQL query pattern", num_tables: "Number of Olist tables referenced", num_joins: "Number of JOIN operations", num_filters: "Parsed filter predicates", num_aggregations: "Aggregate functions in the query", plan_type: "PostgreSQL's actual root plan node", scan_type: "Observed scan method", join_type: "Observed join algorithm", estimated_cost: "PostgreSQL planner cost estimate", estimated_rows: "Planner-estimated output rows", plan_depth: "Execution plan depth", num_nodes: "Number of plan nodes", predicted_time: "Model prediction where available", actual_time: "Measured execution time in milliseconds" };
  return descriptions[feature] || "Measured query feature";
}

function AboutPage() {
  const steps = ["SQL Query", "Query Analysis", "Candidate Plan Generation", "Feature Extraction", "ML Prediction", "Plan Selection", "Query Execution", "Performance Feedback", "Historical Dataset"];
  return <div className="about-stack"><Card><PanelHeading title="Problem Statement" /><p className="body-copy">Traditional database optimizers use cost-based and rule-based approaches to select execution plans. Cost estimates can differ from measured runtime when statistics, join shape, and data distribution change. This project explores whether Machine Learning can assist with query-plan recommendation.</p></Card><Card><PanelHeading title="Objective" /><p className="body-copy">Use historical query and execution-plan measurements to predict execution performance and rank candidate plans against PostgreSQL's default planner.</p></Card><Card><PanelHeading title="System Architecture" /><div className="workflow">{steps.map((step, i) => <div className="workflow-step" key={step}><span>{i + 1}</span><b>{step}</b>{i < steps.length - 1 && <i>→</i>}</div>)}</div></Card><Card><PanelHeading title="Machine Learning Models" /><div className="model-explanations"><div><b>Linear Regression</b><p>Baseline model with a linear relationship between query features and execution time.</p></div><div><b>Random Forest</b><p>Tree ensemble that captures nonlinear patterns between query shape, planner settings, and measured time.</p></div><div><b>Gradient Boosting</b><p>Sequential ensemble evaluated on held-out query shapes.</p></div></div></Card><Card className="note-card"><Info size={16} /><span>Academic prototype. Candidate plan timing varies with database cache, workload, and hosting tier; this tool does not replace PostgreSQL's optimizer.</span></Card></div>;
}

export default App;

