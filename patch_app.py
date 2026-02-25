import re
import sys

with open("app.py", "r", encoding="utf-8") as f:
    content = f.read()

# 1. BackgroundTasks import
content = content.replace(
    "from fastapi import FastAPI, HTTPException",
    "from fastapi import FastAPI, HTTPException, BackgroundTasks"
)

# 2. check_rumination signature
content = content.replace(
    "def check_rumination(user_id: int, current_embedding: list[float], current_text: str, db: sqlite3.Connection, timestamp_override: str | None = None) -> dict:",
    "def check_rumination(user_id: int, current_embedding: list[float], current_text: str, db: sqlite3.Connection, timestamp_override: str | None = None, exclude_node_id: int | None = None) -> dict:"
)

# 3. check_rumination query
old_query = """    # Step 1: Fetch the last 5 entry embeddings for this user from sqlite-vec
    rows = cursor.execute(
        "SELECT vector_embedding FROM drift_nodes WHERE user_id = ? ORDER BY id DESC LIMIT 5",
        (user_id,)
    ).fetchall()"""

new_query = """    # Step 1: Fetch the last 5 entry embeddings for this user from sqlite-vec
    if exclude_node_id is not None:
        rows = cursor.execute(
            "SELECT vector_embedding FROM drift_nodes WHERE user_id = ? AND id != ? ORDER BY id DESC LIMIT 5",
            (user_id, exclude_node_id)
        ).fetchall()
    else:
        rows = cursor.execute(
            "SELECT vector_embedding FROM drift_nodes WHERE user_id = ? ORDER BY id DESC LIMIT 5",
            (user_id,)
        ).fetchall()"""

content = content.replace(old_query, new_query)

# 4. Remove async from analyze_thought and benchmark_analyze
content = content.replace(
    "@app.post(\"/analyze_thought\")\nasync def analyze_thought(payload: EntryPayload) -> dict[str, Any]:",
    "@app.post(\"/analyze_thought\")\ndef analyze_thought(payload: EntryPayload) -> dict[str, Any]:"
)

content = content.replace(
    "@app.post(\"/benchmark_analyze\")\nasync def benchmark_analyze(payload: EntryPayload) -> dict[str, Any]:",
    "@app.post(\"/benchmark_analyze\")\ndef benchmark_analyze(payload: EntryPayload) -> dict[str, Any]:"
)

# 5. Extract run_zero_shot_analysis
background_task_code = """
def run_zero_shot_analysis(node_id: int, user_id: int, full_text: str, automatic_thought: str, vector: list[float], timestamp: str | None) -> None:
    try:
        # Zero-shot classifications
        drift_label = classify_drift(automatic_thought)
        
        wellness_labels = ["negative distress", "neutral reflection", "positive growth"]
        w_res = deberta_classifier(full_text, wellness_labels)
        wellness_label = w_res["labels"][0]
        
        # Connect to DB and update the node
        conn = get_connection()
        try:
            # check_rumination logic needs db connection
            rumination_res = check_rumination(user_id, vector, full_text, conn, timestamp, exclude_node_id=node_id)
            flag_count = safe_int(rumination_res["flag_count"])
            cosine_sim = safe_float(rumination_res.get("cosine_sim", 0.0))
            
            cursor = conn.cursor()
            cursor.execute(\"\"\"
                UPDATE drift_nodes
                SET cognitive_drift = ?,
                    wellness_label = ?,
                    rumination_flag_count = ?,
                    similarity_score = ?
                WHERE id = ?
            \"\"\", (drift_label, wellness_label, flag_count, cosine_sim, node_id))
            conn.commit()
            log.info("Background analysis complete for node %d.", node_id)
        except Exception as inner_exc:
            log.error("Database error in background task for node %d: %s", node_id, inner_exc)
        finally:
            conn.close()
            
    except Exception as exc:
        log.error("Background task failed for node %d: %s", node_id, exc)

@app.post("/save_thought")
"""

content = content.replace("@app.post(\"/save_thought\")\n", background_task_code)

# 6. Replace save_thought old implementation with new one
old_save_thought = """async def save_thought(payload: SaveEntryPayload) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    timestamp = payload.timestamp if payload.timestamp else datetime.now(timezone.utc).isoformat()
    
    # Recalculate
    vector = vectorize(full_text)
    drift_label = classify_drift(payload.automatic_thought)
    
    wellness_labels = ["negative distress", "neutral reflection", "positive growth"]
    w_res = deberta_classifier(full_text, wellness_labels)
    wellness_label = w_res["labels"][0]
    
    belief_shift = 0
    if payload.thought_belief_before is not None and payload.thought_belief_after is not None:
        belief_shift = payload.thought_belief_before - payload.thought_belief_after

    conn = get_connection()
    try:
        cursor = conn.cursor()
        
        # Check rumination (modifies rumination_flags implicitly in check_rumination)
        rumination_res = check_rumination(payload.user_id, vector, full_text, conn, payload.timestamp)
        flag_count = safe_int(rumination_res["flag_count"])
        cosine_sim = safe_float(rumination_res.get("cosine_sim", 0.0))
        
        # Insert node
        cursor.execute(
            \"\"\"
            INSERT INTO drift_nodes
                (user_id, timestamp, situation, automatic_thought, cognitive_drift, context_tags, vector_embedding,
                entry_type, thought_belief_before, emotion, emotion_intensity, evidence_for, evidence_against, reframed_thought, thought_belief_after, belief_shift, wellness_label, rumination_flag_count, similarity_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \"\"\",
            (
                payload.user_id,
                timestamp,
                payload.situation,
                payload.automatic_thought,
                drift_label,
                json.dumps([t.strip().lower() for t in (payload.context_tags or []) if t.strip()]),
                json.dumps(vector),
                payload.entry_type,
                payload.thought_belief_before,
                payload.emotion,
                payload.emotion_intensity,
                payload.evidence_for,
                payload.evidence_against,
                payload.reframed_thought,
                payload.thought_belief_after,
                belief_shift,
                wellness_label,
                flag_count,
                cosine_sim
            ),
        )"""

new_save_thought = """def save_thought(payload: SaveEntryPayload, background_tasks: BackgroundTasks) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    timestamp = payload.timestamp if payload.timestamp else datetime.now(timezone.utc).isoformat()
    
    # Recalculate Fast Path (Synchronous)
    vector = vectorize(full_text)
    
    belief_shift = 0
    if payload.thought_belief_before is not None and payload.thought_belief_after is not None:
        belief_shift = payload.thought_belief_before - payload.thought_belief_after

    conn = get_connection()
    try:
        cursor = conn.cursor()
        
        # Insert node with pending values for heavy NLP tasks
        cursor.execute(
            \"\"\"
            INSERT INTO drift_nodes
                (user_id, timestamp, situation, automatic_thought, cognitive_drift, context_tags, vector_embedding,
                entry_type, thought_belief_before, emotion, emotion_intensity, evidence_for, evidence_against, reframed_thought, thought_belief_after, belief_shift, wellness_label, rumination_flag_count, similarity_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            \"\"\",
            (
                payload.user_id,
                timestamp,
                payload.situation,
                payload.automatic_thought,
                "Analyzing...",
                json.dumps([t.strip().lower() for t in (payload.context_tags or []) if t.strip()]),
                json.dumps(vector),
                payload.entry_type,
                payload.thought_belief_before,
                payload.emotion,
                payload.emotion_intensity,
                payload.evidence_for,
                payload.evidence_against,
                payload.reframed_thought,
                payload.thought_belief_after,
                belief_shift,
                "Analyzing...",
                0,
                0.0
            ),
        )"""

content = content.replace(old_save_thought, new_save_thought)

# Then we need to add the enqueue logic at the end of save_thought
old_save_return = """    except sqlite3.Error as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")
    finally:
        conn.close()
        
    return {
        "status": "saved",
        "node_id": new_node_id,
        "rumination": {
            "rumination_detected": rumination_res["rumination_detected"],
            "flag_count": rumination_res["flag_count"]
        }
    }"""

new_save_return = """    except sqlite3.Error as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")
    finally:
        conn.close()
        
    # Enqueue Background Task for heavy Zero-Shot NLP and DB update
    background_tasks.add_task(
        run_zero_shot_analysis,
        node_id=new_node_id,
        user_id=payload.user_id,
        full_text=full_text,
        automatic_thought=payload.automatic_thought,
        vector=vector,
        timestamp=payload.timestamp
    )
        
    return {
        "status": "success",
        "message": "Thought logged. Analysis running in background.",
        "node_id": new_node_id,
        "rumination": {
            "rumination_detected": False, # Placeholder fast-return
            "flag_count": 0
        }
    }"""

content = content.replace(old_save_return, new_save_return)

with open("app.py", "w", encoding="utf-8") as f:
    f.write(content)

print("Patching complete!")
