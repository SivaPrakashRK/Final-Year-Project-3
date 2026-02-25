import requests
import json
import time

payload = {
    "user_id": 1,
    "situation": "Test benchmark",
    "automatic_thought": "I am so stressed right now",
    "context_tags": ["stress"],
    "entry_type": "free_form"
}

print("Running benchmark_analyze...")
start = time.time()
res = requests.post("http://127.0.0.1:8000/benchmark_analyze", json=payload)
end = time.time()

print(f"Total end-to-end HTTP time: {(end - start)*1000:.1f} ms")
data = res.json()
print("Timings from server:")
print(json.dumps(data.get("timings", {}), indent=2))
