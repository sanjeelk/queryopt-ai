const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; database: string }>("/health"),
  overview: () => request<any>("/api/overview"),
  dataset: () => request<any>("/api/dataset?limit=100"),
  history: () => request<{ items: any[]; count: number }>("/api/query-history?limit=100"),
  models: () => request<any>("/api/models"),
  examples: () => request<{ items: { id: string; sql: string }[] }>("/api/examples"),
  optimize: (sql: string) => request<any>("/api/optimize", { method: "POST", body: JSON.stringify({ sql }) }),
  uploadDataset: (files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return request<any>("/api/dataset/upload", { method: "POST", body });
  },
};

