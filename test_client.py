import requests
import json

try:
    print("\n--- Testing POST /analyze_thought ---")
    payload = {
        "user_id": 1,
        "situation": "Test situation",
        "automatic_thought": "I am a failure and everything is terrible.",
        "context_tags": ["work", "stress"]
    }
    
    res = requests.post("http://127.0.0.1:8000/analyze_thought", json=payload)
    print("STATUS", res.status_code)
    data = res.json()
    print(json.dumps(data, indent=2))
    
    print("\n--- Testing POST /save_thought ---")
    save_payload = payload.copy()
    
    approved_links = []
    if data.get("proposed_links", {}).get("semantic"):
        approved_links.append(data["proposed_links"]["semantic"][0])
        
    save_payload["approved_links"] = approved_links
    
    res2 = requests.post("http://127.0.0.1:8000/save_thought", json=save_payload)
    print("STATUS", res2.status_code)
    print(json.dumps(res2.json(), indent=2))
    
    print("\n--- Testing GET /get_graph_data ---")
    res3 = requests.get("http://127.0.0.1:8000/get_graph_data")
    print("STATUS", res3.status_code)
    d = res3.json()
    print("Nodes:", len(d.get("nodes", [])))
    print("Links:", len(d.get("links", [])))
    if d.get("links"):
        print("Sample link:", d["links"][-1])
        
    print("\n--- Testing GET /drift/weekly ---")
    res4 = requests.get("http://127.0.0.1:8000/drift/weekly")
    print("STATUS", res4.status_code)
    print(json.dumps(res4.json(), indent=2)[:300], "...")
    
except Exception as e:
    print("Error:", e)
