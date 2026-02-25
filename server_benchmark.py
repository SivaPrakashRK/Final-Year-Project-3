import time
import requests
import numpy as np

# Sample realistic payload data (taken from benchmark.py test entries)
test_entries = [
    "Today I felt overwhelmed by the workload at university.",
    "I cannot stop thinking about the portfolio deadline.",
    "Had a good conversation with my friend about the future.",
    "Anxiety about placements is affecting my sleep.",
    "I feel more confident after finishing the project section.",
] * 4  # 20 concurrent/sequential requests

url = "http://localhost:8001/benchmark_analyze"

print(f"Connecting to live server at {url}...")
print("Running real-time performance benchmark across 20 payloads...\n")

total_http_times = []
internal_embed_times = []
internal_sqlite_times = []
internal_total_times = []

success_count = 0

for i, entry in enumerate(test_entries):
    payload = {
        "user_id": 1,
        "situation": "Benchmark Test",
        "automatic_thought": entry,
        "entry_type": "free_form",
        "context_tags": ["benchmark"]
    }
    
    t_start = time.perf_counter()
    try:
        response = requests.post(url, json=payload, timeout=20)
        t_end = time.perf_counter()
        
        if response.status_code == 200:
            success_count += 1
            data = response.json()
            timings = data.get("timings", {})
            
            # Record total round-trip HTTP time
            total_http_times.append((t_end - t_start) * 1000)
            
            if "embedding_time_ms" in timings:
                internal_embed_times.append(timings["embedding_time_ms"] + timings.get("drift_time_ms", 0) + timings.get("wellness_time_ms", 0))
            if "faiss_retrieval_time_ms" in timings:
                internal_sqlite_times.append(timings["faiss_retrieval_time_ms"])
            if "total_internal_time_ms" in timings:
                internal_total_times.append(timings["total_internal_time_ms"])
        else:
            print(f"Request {i+1} failed with status {response.status_code}")
            
    except requests.exceptions.RequestException as e:
        print(f"Request {i+1} failed to connect: {e}")

if success_count == 0:
    print("All requests failed. Is the server running?")
    exit(1)

# Compute averages
avg_http = np.mean(total_http_times)
avg_int_embed = np.mean(internal_embed_times) if internal_embed_times else 0
avg_int_sqlite = np.mean(internal_sqlite_times) if internal_sqlite_times else 0
avg_int_total = np.mean(internal_total_times) if internal_total_times else 0

# Network routing overhead is roughly total HTTP time minus total internal processing time
network_overhead = avg_http - avg_int_total

print("=== REAL-TIME SERVER BENCHMARK RESULTS ===")
print(f"Total Successful Requests: {success_count}/20")
print(f"Avg End-to-End HTTP Time:  {avg_http:.1f} ms")
print(f"Avg Total Inference:       {avg_int_embed:.1f} ms")
print(f"Avg Internal Database Time:{avg_int_sqlite:.1f} ms")
print(f"Avg FastApi/Network Ping:  {network_overhead:.1f} ms")

markdown_output = f"""# Real-Time Server Benchmarks (End-to-End)

| Metric | Result |
| :--- | :--- |
| **Total End-to-End HTTP Latency** | {avg_http:.1f} ms |
|   ↳ *Total Sequential Inference* | {avg_int_embed:.1f} ms |
|   ↳ *Internal Vector Retrieval* | {avg_int_sqlite:.1f} ms |
|   ↳ *FastAPI & Network Overhead* | {network_overhead:.1f} ms |
"""

with open("server_benchmark_results.md", "w", encoding="utf-8") as f:
    f.write(markdown_output)

print("\nResults exported to server_benchmark_results.md")
