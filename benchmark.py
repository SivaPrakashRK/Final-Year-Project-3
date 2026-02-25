import time
import numpy as np
import faiss
import os

import os
import psutil

os.environ["HF_HOME"] = "d:/huggingface"
os.environ["HF_HUB_OFFLINE"] = "1"

def log_progress(msg):
    with open("d:/College/Final Year Project 3/progress.log", "a", encoding="utf-8") as f:
        f.write(msg + "\n")

log_progress("Importing SentenceTransformer...")
from sentence_transformers import SentenceTransformer
log_progress("Imported. Loading model...")

print("Loading model...")
model = SentenceTransformer("BAAI/bge-large-en-v1.5")
log_progress("Model loaded.")

# Sample journal entries for testing
test_entries = [
    "Today I felt overwhelmed by the workload at university.",
    "I cannot stop thinking about the portfolio deadline.",
    "Had a good conversation with my friend about the future.",
    "Anxiety about placements is affecting my sleep.",
    "I feel more confident after finishing the project section.",
] * 40  # gives 200 entries

# ── 1. Embedding latency ──────────────────────────────
log_progress("Testing embedding speed...")
print("\nTesting embedding speed...")
times = []
for entry in test_entries[:20]:
    start = time.perf_counter()
    vec = model.encode(entry, normalize_embeddings=True)
    times.append((time.perf_counter() - start) * 1000)

avg_embed_time = np.mean(times)
log_progress(f"Avg embedding time: {avg_embed_time:.1f} ms")
print(f"Avg embedding time: {avg_embed_time:.1f} ms")
print(f"Min: {np.min(times):.1f} ms  Max: {np.max(times):.1f} ms")

# ── 2. FAISS insert latency ───────────────────────────
log_progress("Testing FAISS insert speed...")
print("\nTesting FAISS insert speed...")
dim = 1024
index = faiss.IndexFlatIP(dim)

log_progress("Encoding all 200 entries...")
all_vecs = model.encode(test_entries, normalize_embeddings=True)
log_progress("Encoding complete. Inserting...")

insert_times = []
for vec in all_vecs:
    start = time.perf_counter()
    index.add(np.array([vec]))
    insert_times.append((time.perf_counter() - start) * 1000)

avg_insert_time = np.mean(insert_times)
log_progress("FAISS insert complete.")
print(f"Avg insert latency: {avg_insert_time:.1f} ms")
print(f"Total for 200 entries: {sum(insert_times):.0f} ms")

# ── 3. Retrieval latency ──────────────────────────────
log_progress("Testing retrieval speed...")
print("\nTesting retrieval speed...")
query_vec = model.encode("anxiety about the future", 
                          normalize_embeddings=True)
retrieval_times = []
for _ in range(20):
    start = time.perf_counter()
    D, I = index.search(np.array([query_vec]), k=5)
    retrieval_times.append((time.perf_counter() - start) * 1000)

avg_retrieval_time = np.mean(retrieval_times)
print(f"Avg top-5 retrieval: {avg_retrieval_time:.1f} ms")

# ── 4. Peak RAM ───────────────────────────────────────
process = psutil.Process(os.getpid())
ram_mb = process.memory_info().rss / 1024 / 1024
print(f"\nPeak RAM usage: {ram_mb:.0f} MB ({ram_mb/1024:.2f} GB)")

# ── 5. Adaptive threshold computation ────────────────
print("\nComputing adaptive threshold...")
start = time.perf_counter()
sample = all_vecs[:50]
sims = []
for i in range(len(sample)):
    for j in range(i+1, len(sample)):
        sims.append(float(np.dot(sample[i], sample[j])))
mu = np.mean(sims)
sigma = np.std(sims)
threshold = mu + sigma
elapsed = (time.perf_counter() - start) * 1000
print(f"Adaptive threshold: {threshold:.4f} (μ={mu:.4f}, σ={sigma:.4f})")
print(f"Threshold compute time: {elapsed:.1f} ms")

print("\n=== COPY THESE TO TABLE IV ===")
print(f"Embedding time:     {avg_embed_time:.0f} ms")
print(f"FAISS insert:       {avg_insert_time:.0f} ms")  
print(f"FAISS retrieval:    {avg_retrieval_time:.1f} ms")
print(f"Peak RAM:           {ram_mb:.0f} MB")
print(f"Adaptive threshold: {threshold:.4f}")

# Export to Markdown file
markdown_output = f"""# Performance Benchmarks

| Metric | Result |
| :--- | :--- |
| **Embedding time** | {avg_embed_time:.0f} ms |
| **FAISS insert** | {avg_insert_time:.0f} ms |
| **FAISS retrieval** | {avg_retrieval_time:.1f} ms |
| **Peak RAM** | {ram_mb:.0f} MB |
| **Adaptive threshold** | {threshold:.4f} |
"""

with open("d:/College/Final Year Project 3/benchmark_results.md", "w", encoding="utf-8") as f:
    f.write(markdown_output)

log_progress("Done!")
print("\nResults successfully exported to d:/College/Final Year Project 3/benchmark_results.md")
