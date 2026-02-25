import os
import re
import json
import time
import requests
import sqlite3
from datetime import datetime, timedelta, timezone

BASE_URL = "http://localhost:8001"

def clear_db():
    print("Clearing database drift_v2.db...")
    db_path = "drift_v2.db"
    if not os.path.exists(db_path):
        print("drift_v2.db not found, skipping clear.")
        return
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("DELETE FROM drift_links")
    c.execute("DELETE FROM drift_nodes")
    c.execute("DELETE FROM rumination_flags")
    c.execute("DELETE FROM sqlite_sequence WHERE name IN ('drift_nodes', 'drift_links')")
    conn.commit()
    conn.close()
    print("Database SQLite tables cleared.")

def parse_entries():
    with open("Entries.md", "r", encoding="utf-8") as f:
        content = f.read()

    # Split by Entry headers
    blocks = re.split(r'\*\*Entry \d+.*?\*\*', content)[1:]
    
    parsed_entries = []
    
    for b in blocks:
        sit = re.search(r'\*\*Situation:\*\*\s*(.+)', b)
        thought = re.search(r'\*\*First Thought:\*\*\s*(.+)', b)
        belief = re.search(r'\*\*Belief %:\*\*\s*(\d+)', b)
        emo = re.search(r'\*\*Emotion:\*\*\s*([A-Za-z\s\-]+?)\s*\((\d+)%\)', b)
        ev_for = re.search(r'\*\*Evidence For:\*\*\s*(.+)', b)
        ev_ag = re.search(r'\*\*Evidence Against:\*\*\s*(.+)', b)
        reframed = re.search(r'\*\*Reframed Thought:\*\*\s*(.+)', b)
        rev_belief = re.search(r'\*\*Revised Belief %:\*\*\s*(\d+)', b)
        tags_line = re.search(r'\*\*Tags:\*\*\s*(.+)', b)
        
        if sit and thought:
            tags = [t.strip(' `') for t in tags_line.group(1).split(',')] if tags_line else []
            entry = {
                "situation": sit.group(1).strip(),
                "automatic_thought": thought.group(1).strip(),
                "thought_belief_before": int(belief.group(1)) if belief else None,
                "emotion": emo.group(1).strip() if emo else None,
                "emotion_intensity": int(emo.group(2)) if emo else None,
                "evidence_for": ev_for.group(1).strip() if ev_for else None,
                "evidence_against": ev_ag.group(1).strip() if ev_ag else None,
                "reframed_thought": reframed.group(1).strip() if reframed else None,
                "thought_belief_after": int(rev_belief.group(1)) if rev_belief else None,
                "context_tags": tags,
                "entry_type": "evidence_reframe_diary"
            }
            parsed_entries.append(entry)
            
    return parsed_entries

def main():
    print("==========================================================")
    print("WARNING: You must restart the FastAPI server before running")
    print("the new timestamp override feature is loaded from app.py")
    print("==========================================================")
    time.sleep(3)
    
    clear_db()
    
    entries = parse_entries()
    print(f"\nParsed {len(entries)} entries from Entries.md")
    
    now = datetime.now(timezone.utc)
    
    for i, entry in enumerate(entries):
        days_ago = len(entries) - i
        # Setup each entry on a separate day at 12:00 PM
        timestamp = (now - timedelta(days=days_ago)).replace(hour=12, minute=0, second=0, microsecond=0).isoformat()
        
        entry["timestamp"] = timestamp
        
        print(f"\n--- Processing Entry {i+1}/{len(entries)} ---")
        print(f"Date: {timestamp} | Thought: {entry['automatic_thought'][:40]}...")
        
        try:
            analyze_resp = requests.post(f"{BASE_URL}/analyze_thought", json=entry)
            analyze_resp.raise_for_status()
            analyze_data = analyze_resp.json()
            
            proposed_links = analyze_data.get("proposed_links", {})
            approved_links = []
            for ltype, links in proposed_links.items():
                for l in links:
                    approved_links.append({"target_id": l["target_id"], "link_type": l["link_type"]})
            
            entry["approved_links"] = approved_links
            save_resp = requests.post(f"{BASE_URL}/save_thought", json=entry)
            save_resp.raise_for_status()
            save_data = save_resp.json()
            
            print(f"  -> SUCCESS: Node {save_data.get('node_id')} | Rumination Guard: {save_data.get('rumination', {}).get('rumination_detected')}")
            
        except requests.exceptions.ConnectionError:
            print("  -> ERROR: Could not connect to the server at localhost:8000. Is the FastAPI server running?")
            break
        except Exception as e:
            print(f"  -> ERROR on entry {i+1}: {e}")
            if hasattr(e, 'response') and e.response:
                print(f"     Details: {e.response.text}")
                
        time.sleep(1)
        
    print("\nInjection complete!")

if __name__ == "__main__":
    main()
