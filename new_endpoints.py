
def _format_full_text(payload: EntryPayload) -> str:
    if payload.entry_type == "thought_diary":
        return (
            f"Situation: {payload.situation}. "
            f"Thought: {payload.automatic_thought} (belief: {payload.thought_belief_before}%). "
            f"Emotion: {payload.emotion} at {payload.emotion_intensity}%. "
            f"Evidence supporting this thought: {payload.evidence_for}. "
            f"Evidence against this thought: {payload.evidence_against}. "
            f"Reframed perspective: {payload.reframed_thought} "
            f"(revised belief: {payload.thought_belief_after}%)"
        )
    return payload.automatic_thought

@app.post("/analyze_thought")
async def analyze_thought(payload: EntryPayload) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    
    # Generate Embedding
    try:
        vector = vectorize(full_text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Embedding error: {exc}")

    # Classifications
    drift_label = classify_drift(payload.automatic_thought)
    
    wellness_labels = ["negative distress", "neutral reflection", "positive growth"]
    w_res = deberta_classifier(full_text, wellness_labels)
    wellness_label = w_res["labels"][0]
    wellness_score = w_res["scores"][0]
    
    # Adaptive Min-P Threshold & Candidates
    conn = get_connection()
    try:
        cursor = conn.cursor()
        
        # We need to compute adaptive threshold (mu + sigma) over existing user DB
        rows = cursor.execute(
            "SELECT id, vector_embedding, timestamp, situation, automatic_thought, context_tags, entry_type, wellness_label FROM drift_nodes WHERE user_id = ?",
            (payload.user_id,)
        ).fetchall()
        
        semantic_links = []
        compensatory_links = []
        contextual_links = []
        
        adaptive_threshold = 0.75 # Default fallback
        cd_score = 0.0
        
        if rows:
            all_vecs = []
            for r in rows:
                v = json.loads(r["vector_embedding"])
                all_vecs.append(v)
                
            all_np = np.array(all_vecs, dtype=np.float32)
            curr_np = np.array([vector], dtype=np.float32)
            
            faiss.normalize_L2(all_np)
            faiss.normalize_L2(curr_np)
            
            # Compute similarities to all nodes
            sims = np.dot(all_np, curr_np[0])
            mu = float(np.mean(sims))
            sigma = float(np.std(sims))
            adaptive_threshold = max(0.50, min(0.95, mu + sigma))
            
            # Global mean for Cognitive Drift CD(W)
            all_time_mean = np.mean(all_np, axis=0)
            norm_all = np.linalg.norm(all_time_mean)
            if norm_all > 0:
                dot_p = np.dot(curr_np[0], all_time_mean)
                cd_score = 1.0 - max(0.0, min(1.0, dot_p / norm_all))
            
            now_dt = datetime.now(timezone.utc)
            cutoff_7d = now_dt - timedelta(days=7)
            
            new_tags_set = {t.lower().strip() for t in payload.context_tags}
            
            for i, r in enumerate(rows):
                sim = float(sims[i])
                hist_id = r["id"]
                preview = r["automatic_thought"][:120]
                hist_tags = {t.lower().strip() for t in json.loads(r["context_tags"] or "[]")}
                
                # Semantic Candidates
                if sim > adaptive_threshold:
                    semantic_links.append({
                        "target_id": hist_id,
                        "similarity": round(sim, 4),
                        "created_at": r["timestamp"],
                        "preview": preview,
                        "entry_type": r["entry_type"] or "free_form",
                        "tags": list(hist_tags),
                        "link_type": "semantic"
                    })
                    
                # Compensatory Candidates
                # opposite wellness label, same topic (shared tag), within 7 days, sim >= 0.55
                # Negative vs Positive mapping
                hist_wellness = r["wellness_label"]
                is_opposite = False
                if wellness_label == "negative distress" and hist_wellness == "positive growth":
                    is_opposite = True
                elif wellness_label == "positive growth" and hist_wellness == "negative distress":
                    is_opposite = True
                    
                has_shared_tag = len(new_tags_set & hist_tags) > 0
                
                try:
                    hist_dt = datetime.fromisoformat(r["timestamp"]).replace(tzinfo=timezone.utc)
                except ValueError:
                    hist_dt = datetime.min.replace(tzinfo=timezone.utc)
                    
                if is_opposite and has_shared_tag and (hist_dt >= cutoff_7d) and (sim >= 0.55):
                    compensatory_links.append({
                        "target_id": hist_id,
                        "similarity": round(sim, 4),
                        "created_at": r["timestamp"],
                        "preview": preview,
                        "entry_type": r["entry_type"] or "free_form",
                        "tags": list(hist_tags),
                        "link_type": "compensatory"
                    })
                    
                # Contextual Candidates (Context links)
                if len(new_tags_set & hist_tags) >= CONTEXT_LINK_MIN_TAGS:
                    if hist_id != new_node_id: # wait, new node is not in DB yet
                        contextual_links.append({
                            "target_id": hist_id,
                            "similarity": round(sim, 4),
                            "created_at": r["timestamp"],
                            "preview": preview,
                            "entry_type": r["entry_type"] or "free_form",
                            "tags": list(hist_tags),
                            "link_type": "contextual"
                        })
                    
        # Sort and limit candidates
        semantic_links = sorted(semantic_links, key=lambda x: x["similarity"], reverse=True)[:8]
        compensatory_links = sorted(compensatory_links, key=lambda x: x["similarity"], reverse=True)[:3]
        contextual_links = sorted(contextual_links, key=lambda x: x["similarity"], reverse=True)
        
        # Rumination Guard check (do not trigger save, check only)
        rumination_res = check_rumination(payload.user_id, vector, full_text, conn)
        
    except sqlite3.Error as exc:
        log.error("DB error in analyze_thought: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")
    finally:
        conn.close()
        
    # classify_drift returns just the term, we can't get score so put 1.0
    return {
        "classification": {
            "drift_label": drift_label,
            "drift_score": 1.0, 
            "wellness_label": wellness_label,
            "wellness_score": round(wellness_score, 4),
            "cognitive_drift": round(cd_score, 4)
        },
        "rumination": {
            "rumination_detected": rumination_res["rumination_detected"],
            "flag_count": rumination_res["flag_count"]
        },
        "proposed_links": {
            "semantic": semantic_links,
            "compensatory": compensatory_links,
            "contextual": contextual_links
        },
        "adaptive_threshold": round(adaptive_threshold, 4)
    }


@app.post("/save_thought")
async def save_thought(payload: SaveEntryPayload) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    timestamp = datetime.now(timezone.utc).isoformat()
    
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
        rumination_res = check_rumination(payload.user_id, vector, full_text, conn)
        flag_count = safe_int(rumination_res["flag_count"])
        cosine_sim = safe_float(rumination_res.get("cosine_sim", 0.0))
        
        # Insert node
        cursor.execute(
            """
            INSERT INTO drift_nodes
                (user_id, timestamp, situation, automatic_thought, cognitive_drift, context_tags, vector_embedding,
                entry_type, thought_belief_before, emotion, emotion_intensity, evidence_for, evidence_against, reframed_thought, thought_belief_after, belief_shift, wellness_label, rumination_flag_count, similarity_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.user_id,
                timestamp,
                payload.situation,
                payload.automatic_thought,
                drift_label,
                json.dumps(payload.context_tags),
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
        )
        new_node_id = cursor.lastrowid
        
        # Chronological Link (auto-verified)
        prev_node = cursor.execute("SELECT id FROM drift_nodes WHERE user_id = ? AND id != ? ORDER BY id DESC LIMIT 1", (payload.user_id, new_node_id)).fetchone()
        if prev_node:
            cursor.execute(
                "INSERT INTO drift_links (source_id, target_id, link_type, details, verified) VALUES (?, ?, ?, ?, ?)",
                (new_node_id, prev_node["id"], "chronological", "Chronological sequence", 1)
            )
            
        # Approved Links
        for link in payload.approved_links:
            target_id = link.get("target_id")
            l_type = link.get("link_type", "semantic")
            if target_id:
                cursor.execute(
                    "INSERT INTO drift_links (source_id, target_id, link_type, details, verified) VALUES (?, ?, ?, ?, ?)",
                    (new_node_id, target_id, l_type, f"User-verified {l_type} link", 1)
                )
                
        conn.commit()
        
        # Insert into FAISS
        new_vec_np = np.array([vector], dtype=np.float32)
        faiss.normalize_L2(new_vec_np)
        new_faiss_pos = faiss_index.ntotal
        faiss_index.add(new_vec_np)
        id_mapping[new_faiss_pos] = new_node_id

    except sqlite3.Error as exc:
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
    }
