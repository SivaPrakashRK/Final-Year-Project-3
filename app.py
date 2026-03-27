"""
app.py — Cognitive Drift Detection System  V2
Backend: FastAPI + SQLite + Sentence-Transformers (bge-large-en-v1.5)
"""

# WELLNESS DISCLAIMER: Cognitive Canvas is a self-awareness 
# tool. Not a clinical diagnostic service.

from __future__ import annotations

import os
os.environ["HF_HOME"] = "d:/huggingface"
import sqlite_vec
import json
import logging
import sqlite3
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer
from transformers import pipeline as hf_pipeline


# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
DB_FILE        = "drift_v2.db"
MODEL_NAME     = "BAAI/bge-large-en-v1.5"
EMBED_PREFIX   = "Represent this sentence for retrieval: "

# Graph-linking thresholds (calibrated)
CONTEXT_LINK_MIN_TAGS   = 2      # shared tags required for a Context link

def blob_to_vec(blob):
    if isinstance(blob, str):
        return json.loads(blob)
    return blob

def cosine_similarity(v1, v2):
    vec1 = np.array(v1, dtype=np.float32)
    vec2 = np.array(v2, dtype=np.float32)
    norm1 = np.linalg.norm(vec1)
    norm2 = np.linalg.norm(vec2)
    if norm1 > 0 and norm2 > 0:
        return float(np.dot(vec1, vec2) / (norm1 * norm2))
    return 0.0

def normalize_l2(x: np.ndarray) -> None:
    # In-place L2 normalization mimicking faiss.normalize_L2
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms[norms == 0] = 1 # prevent zero division
    x /= norms

def compute_adaptive_threshold(conn):
    rows = conn.execute(
        "SELECT vector_embedding FROM drift_nodes "
        "WHERE vector_embedding IS NOT NULL"
    ).fetchall()
    if len(rows) < 3:
        return 0.75  # fallback for sparse database
    
    vecs = [blob_to_vec(r["vector_embedding"]) 
            for r in rows]
    sample = vecs[:50]
    similarities = []
    for i in range(len(sample)):
        for j in range(i + 1, len(sample)):
            similarities.append(
                cosine_similarity(sample[i], sample[j])
            )
    if not similarities:
        return 0.75
    mu    = np.mean(similarities)
    sigma = np.std(similarities)
    return float(mu + sigma)

# Rumination Guard parameters
RUMINATION_SIM_THRESHOLD = 0.85  # minimum cosine sim to count as a rumination match
RUMINATION_MIN_MATCHES   = 3     # how many such matches within the window triggers the guard
RUMINATION_WINDOW_HOURS  = 24    # look-back window in hours

# ── FAISS index ───────────────────────────────────────────────────────────────
VECTOR_DIMENSION = 1024                              # bge-large-en-v1.5 output dim
faiss_index      = faiss.IndexFlatIP(VECTOR_DIMENSION)  # Inner Product ≡ cosine sim on L2-normalised vecs
id_mapping: dict[int, int] = {}                      # FAISS sequential index → SQLite node id

# ── Model (loaded once at startup) ───────────────────────────────────────────
_model: SentenceTransformer | None = None

# ── Zero-shot classifier ──────────────────────────────────────────────
log.info("Loading deberta-v3-base-zeroshot model for classification…")
classifier = hf_pipeline(
    "zero-shot-classification",
    model="MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli"
)
log.info("Classifier ready.")

DRIFT_LABELS = [
    "anxiety", "motivation", "relationships", "work",
    "identity", "creativity", "health", "grief", 
    "joy", "uncertainty"
]

WELLNESS_LABELS = [
    "negative distress", "neutral reflection", "positive growth"
]

_CONFIDENCE_THRESHOLD = 0.60


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        log.info("Loading embedding model: %s …", MODEL_NAME)
        _model = SentenceTransformer(MODEL_NAME)
        log.info("Model loaded — embedding dim: %d", _model.get_sentence_embedding_dimension())
    return _model


# ── Database ──────────────────────────────────────────────────────────────────
def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def init_db() -> None:
    """Create tables if they do not already exist."""
    conn = get_connection()
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS drift_nodes (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id          INTEGER NOT NULL DEFAULT 1,
                timestamp        TEXT    NOT NULL,
                situation        TEXT    NOT NULL,
                automatic_thought TEXT   NOT NULL,
                cognitive_drift  TEXT    NOT NULL DEFAULT 'None',
                context_tags     TEXT    NOT NULL DEFAULT '[]',   -- JSON array
                vector_embedding TEXT    NOT NULL DEFAULT '[]'    -- JSON array (1024-D)
            );

            CREATE TABLE IF NOT EXISTS drift_links (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                target_id INTEGER NOT NULL,
                link_type TEXT    NOT NULL,
                details   TEXT,
                verified  INTEGER DEFAULT 0,
                FOREIGN KEY (source_id) REFERENCES drift_nodes(id),
                FOREIGN KEY (target_id) REFERENCES drift_nodes(id)
            );

            CREATE TABLE IF NOT EXISTS rumination_flags (
                user_id      TEXT PRIMARY KEY DEFAULT 'local',
                flag_count   INTEGER DEFAULT 0,
                last_updated TEXT
            );
        """)
        
        try:
            conn.execute("INSERT OR IGNORE INTO rumination_flags (user_id, flag_count) VALUES ('local', 0)")
        except sqlite3.IntegrityError:
            # Catch datatype mismatch if user_id was previously created as INTEGER
            log.info("Migrating rumination_flags to fix user_id datatype...")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS rumination_flags_new (
                    user_id      TEXT PRIMARY KEY DEFAULT 'local',
                    flag_count   INTEGER DEFAULT 0,
                    last_updated TEXT
                );
                INSERT OR IGNORE INTO rumination_flags_new (user_id, flag_count, last_updated)
                SELECT CAST(user_id AS TEXT), flag_count, last_updated FROM rumination_flags;
                DROP TABLE rumination_flags;
                ALTER TABLE rumination_flags_new RENAME TO rumination_flags;
                
                INSERT OR IGNORE INTO rumination_flags (user_id, flag_count) VALUES ('local', 0);
            """)
        # Migration: add details column to existing databases that predate this column
        try:
            conn.execute("ALTER TABLE drift_links ADD COLUMN details TEXT")
            log.info("Migrated drift_links: added 'details' column.")
        except sqlite3.OperationalError:
            pass  # column already exists — no action needed

        try:
            conn.execute("ALTER TABLE drift_links ADD COLUMN verified INTEGER DEFAULT 0")
            log.info("Migrated drift_links: added 'verified' column.")
        except sqlite3.OperationalError:
            pass

        try:
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN wellness_label TEXT")
            log.info("Migrated drift_nodes: added 'wellness_label' column.")
        except sqlite3.OperationalError:
            pass
            
        try:
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN user_id INTEGER DEFAULT 1")
            log.info("Migrated drift_nodes: added 'user_id' column.")
        except sqlite3.OperationalError:
            pass
            
        try:
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN rumination_flag_count INTEGER DEFAULT 0")
            log.info("Migrated drift_nodes: added 'rumination_flag_count' column.")
        except sqlite3.OperationalError:
            pass
            
        try:
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN similarity_score REAL DEFAULT 0.0")
            log.info("Migrated drift_nodes: added 'similarity_score' column.")
        except sqlite3.OperationalError:
            pass
            
        # ── Thought Diary Migrations ───────────────────────────────
        try:
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN entry_type TEXT DEFAULT 'free_form'")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN thought_belief_before INTEGER")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN emotion TEXT")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN emotion_intensity INTEGER")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN evidence_for TEXT")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN evidence_against TEXT")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN reframed_thought TEXT")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN thought_belief_after INTEGER")
            conn.execute("ALTER TABLE drift_nodes ADD COLUMN belief_shift INTEGER")
            log.info("Migrated drift_nodes: added thought_diary columns.")
        except sqlite3.OperationalError:
            pass

    conn.close()
    log.info("Database initialised: %s", DB_FILE)


# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    get_model()          # warm up — avoids cold-start latency on first request

    # ── Pre-load existing vectors into sqlite-vec ────────────────────────
    conn = get_connection()
    try:
        conn.execute("DELETE FROM vec_embeddings")
        rows = conn.execute(
            "SELECT id, vector_embedding FROM drift_nodes ORDER BY id ASC"
        ).fetchall()
        count = 0
        if rows:
            for row in rows:
                vec = json.loads(row["vector_embedding"] or "[]")
                if len(vec) == VECTOR_DIMENSION:
                    vec_np = np.array([vec], dtype=np.float32)
                    normalize_l2(vec_np)
                    conn.execute("INSERT INTO vec_embeddings(rowid, embedding) VALUES (?, ?)", 
                                 (row["id"], sqlite_vec.serialize_float32(vec_np[0])))
                    count += 1
            conn.commit()
            log.info("sqlite-vec index loaded with %d existing vectors.", count)
    except Exception as exc:  # noqa: BLE001
        log.error("Failed to pre-load sqlite-vec index: %s", exc)
    finally:
        conn.close()

    yield
    log.info("Shutting down.")


# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Cognitive Drift Detection System — V2",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # tighten in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic schema ───────────────────────────────────────────────────────────
class EntryPayload(BaseModel):
    user_id:                int       = 1
    situation:              str       = "Freeform Entry"
    automatic_thought:      str       = Field(..., min_length=1)
    context_tags:           list[str] = Field(default_factory=list)
    entry_type:             str       = "free_form"
    timestamp:              str | None = None

    
    # Optional fields for thought diary
    thought_belief_before:  int | None = None
    emotion:                str | None = None
    emotion_intensity:      int | None = None
    evidence_for:           str | None = None
    evidence_against:       str | None = None
    reframed_thought:       str | None = None
    thought_belief_after:   int | None = None

class SaveEntryPayload(EntryPayload):
    approved_links:         list[dict] = Field(default_factory=list)

# ── Maths helpers ─────────────────────────────────────────────────────────────
def safe_float(val: Any) -> float:
    if val is None:
        return 0.0
    if isinstance(val, bytes):
        try:
            return float(np.frombuffer(val, dtype=np.float32)[0])
        except Exception:
            return 0.0
    try:
        return float(val)
    except Exception:
        return 0.0

def safe_int(val: Any) -> int:
    if val is None:
        return 0
    if isinstance(val, bytes):
        try:
            return int(np.frombuffer(val, dtype=np.int64)[0])
        except Exception:
            return 0
    try:
        return int(val)
    except Exception:
        return 0

def vectorize(text: str) -> list[float]:
    """Encode text with the BGE-large model; returns a Python list."""
    model = get_model()
    # BGE models perform best with the query prefix
    embedding = model.encode(EMBED_PREFIX + text, normalize_embeddings=True)
    return embedding.tolist()


def classify_drift(thought: str) -> str:
    """
    Run zero-shot classification on the automatic thought and return the
    corresponding drift term, or 'None' if confidence is too low.
    """
    try:
        result    = classifier(thought, DRIFT_LABELS)
        top_label = result["labels"][0]
        top_score = result["scores"][0]

        log.info(
            "Drift classification: '%s' (score=%.3f)", top_label, top_score
        )

        if top_score < _CONFIDENCE_THRESHOLD:
            return "None"

        return top_label.title()

    except Exception as exc:  # noqa: BLE001
        log.error("Drift classifier failed: %s", exc)
        return "None"


# Wellness pattern detection only. Not a diagnostic tool.
def check_rumination(conn, current_vec, current_text):
    N, T_SIM, P_NEG, K = 5, 0.88, 0.70, 3
    
    recent = conn.execute("""
        SELECT vector_embedding FROM drift_nodes
        WHERE vector_embedding IS NOT NULL
        ORDER BY id DESC LIMIT ?
    """, (N,)).fetchall()
    
    if len(recent) < N:
        return {"rumination_detected": False, 
                "flag_count": 0}
    
    recent_vecs = [
        blob_to_vec(r["vector_embedding"]) 
        for r in recent
    ]
    mean_vec    = np.mean(recent_vecs, axis=0)
    similarity  = cosine_similarity(current_vec, 
                                    mean_vec)
    
    result    = classifier(current_text, 
                           WELLNESS_LABELS)
    label_map = dict(zip(result["labels"], 
                         result["scores"]))
    p_neg     = label_map.get("negative distress", 0.0)
    
    flag_row = conn.execute(
        "SELECT flag_count FROM rumination_flags "
        "WHERE user_id = 'local'"
    ).fetchone()
    flag_count = flag_row["flag_count"] if flag_row else 0
    
    if similarity > T_SIM and p_neg > P_NEG:
        flag_count += 1
    else:
        flag_count = 0
    
    conn.execute(
        "UPDATE rumination_flags SET flag_count = ? "
        "WHERE user_id = 'local'", (flag_count,)
    )
    conn.commit()
    
    rumination_detected = flag_count >= K
    if rumination_detected:
        conn.execute(
            "UPDATE rumination_flags SET flag_count = 0 "
            "WHERE user_id = 'local'"
        )
        conn.commit()
    
    return {
        "rumination_detected": rumination_detected,
        "flag_count":          flag_count,
        "similarity_to_mean":  round(similarity, 4),
    }

# ── Graph logic & Rumination Guard ───────────────────────────────────────────
def process_graph_and_guard(
    new_node_id: int,
    new_vector:  list[float],
    new_tags:    list[str],
    timestamp:   str,
    conn:        sqlite3.Connection,
) -> bool:
    """
    Build graph links for the new node and detect rumination.

    Semantic links   → resolved via FAISS top-K search (fast, scalable).
    Context links    → resolved via SQLite tag-overlap (no vector math needed).
    Rumination guard → piggy-backs on the same FAISS pass.

    Returns
    -------
    bool
        True  → rumination loop detected.
        False → no rumination.
    """
    cursor = conn.cursor()
    links_to_insert: list[tuple[int, int, str, str]] = []  # (source, target, type, details)

    # ── Parse the rumination window cut-off ───────────────────────────────────
    try:
        now_dt = datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc)
    except ValueError:
        now_dt = datetime.now(timezone.utc)
    rumination_cutoff = now_dt - timedelta(hours=RUMINATION_WINDOW_HOURS)
    rumination_count = 0
    
    threshold = compute_adaptive_threshold(conn)

    # ── 1. FAISS search — Semantic links + Rumination Guard ───────────────────
    if faiss_index.ntotal > 0:
        query = np.array([new_vector], dtype=np.float32)
        faiss.normalize_L2(query)

        k = min(10, faiss_index.ntotal)
        distances, indices = faiss_index.search(query, k)

        for faiss_pos, sim in zip(indices[0], distances[0]):
            if faiss_pos < 0:                           # unfilled slot sentinel
                continue
            hist_id = id_mapping.get(int(faiss_pos))
            if hist_id is None or hist_id == new_node_id:
                continue

            # Semantic link
            if sim > threshold:
                details = f"{int(sim * 100)}% Semantic Match"
                links_to_insert.append((new_node_id, hist_id, "Semantic", details))
                log.debug(
                    "Semantic link: %d → %d (sim=%.4f)", new_node_id, hist_id, sim
                )

            # Rumination Guard — check the time window via DB
            if sim > RUMINATION_SIM_THRESHOLD:
                row = cursor.execute(
                    "SELECT timestamp FROM drift_nodes WHERE id = ?", (hist_id,)
                ).fetchone()
                if row:
                    try:
                        hist_dt = datetime.fromisoformat(row["timestamp"]).replace(
                            tzinfo=timezone.utc
                        )
                    except ValueError:
                        hist_dt = datetime.min.replace(tzinfo=timezone.utc)
                    if hist_dt >= rumination_cutoff:
                        rumination_count += 1
                        log.debug(
                            "Rumination candidate: node %d (sim=%.4f)", hist_id, sim
                        )

    # ── 2. Context links — tag overlap only (SQLite, no vectors) ─────────────
    new_tags_set = {t.lower().strip() for t in new_tags}
    if new_tags_set:
        for row in cursor.execute(
            "SELECT id, context_tags FROM drift_nodes WHERE id != ?", (new_node_id,)
        ).fetchall():
            hist_tags = {
                t.lower().strip()
                for t in json.loads(row["context_tags"] or "[]")
            }
            shared_tags = new_tags_set & hist_tags
            if len(shared_tags) >= CONTEXT_LINK_MIN_TAGS:
                details = f"Shared Context: {len(shared_tags)} tag{'s' if len(shared_tags) != 1 else ''}"
                links_to_insert.append((new_node_id, row["id"], "Context", details))
                log.debug(
                    "Context link: %d → %d (shared=%s)",
                    new_node_id, row["id"], shared_tags,
                )

    # ── 3. Batch-insert links (duplicate-safe) ────────────────────────────────
    for source, target, ltype, details in links_to_insert:
        cursor.execute(
            """
            INSERT INTO drift_links (source_id, target_id, link_type, details)
            SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM drift_links
                WHERE source_id = ? AND target_id = ? AND link_type = ?
            )
            """,
            (source, target, ltype, details, source, target, ltype),
        )
    conn.commit()

    # ── 4. Add new vector to FAISS index ─────────────────────────────────────
    new_vec_np = np.array([new_vector], dtype=np.float32)
    faiss.normalize_L2(new_vec_np)
    new_faiss_pos = faiss_index.ntotal          # position before add
    faiss_index.add(new_vec_np)
    id_mapping[new_faiss_pos] = new_node_id
    log.debug(
        "FAISS index updated: total=%d, new_pos=%d → node id=%d",
        faiss_index.ntotal, new_faiss_pos, new_node_id,
    )

    # ── 5. Rumination result ──────────────────────────────────────────────────
    rumination_detected = rumination_count >= RUMINATION_MIN_MATCHES
    if rumination_detected:
        log.warning(
            "RUMINATION GUARD triggered for node %d — %d similar nodes in last %dh",
            new_node_id, rumination_count, RUMINATION_WINDOW_HOURS,
        )
    return rumination_detected
    return rumination_detected

# ── Transitive Reduction ──────────────────────────────────────────────────────
class TransitiveReducer:
    def __init__(self, entries: list[dict], links: list[dict]):
        self.entries = {e['id']: e for e in entries}
        self.links = links
        self.adjacency = defaultdict(set)
        self._build_adjacency()
    
    def _build_adjacency(self):
        """Build adjacency list from chronological links only."""
        chronological_links = [l for l in self.links if (l.get('link_type') or '').lower() == 'chronological']
        for link in chronological_links:
            self.adjacency[link['source_id']].add(link['target_id'])
    
    def _find_path(self, source_id: int, target_id: int, max_hops: int = 10) -> list[int]:
        """Find if a path exists between source and target using BFS."""
        if source_id == target_id:
            return [source_id]
        
        queue = deque([(source_id, [source_id])])
        visited = {source_id}
        
        while queue:
            current, path = queue.popleft()
            
            if len(path) > max_hops:
                continue
            
            for neighbor in self.adjacency[current]:
                if neighbor == target_id:
                    return path + [neighbor]
                
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, path + [neighbor]))
        
        return []
    
    def reduce(self, min_temporal_gap: int = 2) -> list[dict]:
        """Apply transitive reduction to semantic links."""
        chronological = [l for l in self.links if (l.get('link_type') or '').lower() == 'chronological']
        contextual = [l for l in self.links if (l.get('link_type') or '').lower() == 'contextual']
        semantic = [l for l in self.links if (l.get('link_type') or '').lower() == 'semantic']
        compensatory = [l for l in self.links if (l.get('link_type') or '').lower() == 'compensatory']
        
        self.adjacency = defaultdict(set)
        for link in chronological:
            self.adjacency[link['source_id']].add(link['target_id'])
        
        reduced_semantic = []
        
        for link in semantic:
            source_id = link['source_id']
            target_id = link['target_id']
            
            source_entry = self.entries.get(source_id)
            target_entry = self.entries.get(target_id)
            
            if not source_entry or not target_entry:
                continue
            
            source_time = source_entry.get('timestamp')
            target_time = target_entry.get('timestamp')
            
            try:
                s_dt = datetime.fromisoformat(source_time)
                t_dt = datetime.fromisoformat(target_time)
                temporal_gap = abs((t_dt - s_dt).days)
            except (ValueError, TypeError):
                temporal_gap = 0
            
            if temporal_gap < min_temporal_gap:
                path = self._find_path(source_id, target_id)
                if path:
                    continue
            
            reduced_semantic.append(link)
        
        return chronological + contextual + reduced_semantic + compensatory


# ── POST /analyze_thought & /save_thought ───────────────────────────────────

def _format_full_text(payload: EntryPayload) -> str:
    if payload.entry_type == "evidence_reframe_diary":
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

def find_semantic_chain_link(conn, current_vec, current_id, threshold):
    """
    Walks backwards through entry history.
    Returns at most ONE link — the nearest 
    semantically meaningful predecessor.
    Ensures chain topology, not web topology.
    """
    rows = conn.execute("""
        SELECT id, timestamp, automatic_thought,
               situation, entry_type, context_tags,
               vector_embedding, wellness_label
        FROM drift_nodes
        WHERE id < ?
          AND vector_embedding IS NOT NULL
        ORDER BY id DESC
        LIMIT 20
    """, (current_id or 999999,)).fetchall()
    
    for row in rows:
        vec = blob_to_vec(row["vector_embedding"])
        sim = cosine_similarity(current_vec, vec)
        
        if sim >= threshold:
            preview = (
                row["automatic_thought"] or
                row["situation"] or ""
            )
            return [{
                "target_id":  row["id"],
                "similarity": round(sim, 4),
                "created_at": row["timestamp"],
                "preview":    preview[:120],
                "entry_type": row["entry_type"] or "free_form",
                "tags": json.loads(
                    row["context_tags"] or "[]"
                ),
                "link_type": "semantic",
            }]
    return []

def find_contextual_chain_link(conn, tags, current_id):
    if not tags:
        return []
    
    rows = conn.execute("""
        SELECT id, timestamp, automatic_thought,
               situation, entry_type, context_tags
        FROM drift_nodes
        WHERE id < ?
          AND context_tags IS NOT NULL
          AND context_tags != ''
          AND context_tags != '[]'
        ORDER BY id DESC
        LIMIT 50
    """, (current_id or 999999,)).fetchall()

    incoming = set(
        t.strip().lower() for t in tags if t.strip()
    )

    for row in rows:
        raw = row["context_tags"] or "[]"
        try:
            stored = json.loads(raw)
            if not isinstance(stored, list):
                stored = [str(stored)]
        except (json.JSONDecodeError, ValueError):
            stored = [
                t.strip() for t in raw.split(",")
            ]
        
        stored_norm = set(
            t.strip().lower() for t in stored 
            if t.strip()
        )
        shared = incoming & stored_norm
        
        if shared:
            preview = (
                row["automatic_thought"] or 
                row["situation"] or ""
            )
            return [{
                "target_id":  row["id"],
                "similarity": 1.0,
                "created_at": row["timestamp"],
                "preview":    preview[:120],
                "entry_type": row["entry_type"] or "free_form",
                "tags":       list(stored_norm),
                "link_type":  "contextual",
                "shared_tag": list(shared)[0],
            }]
    return []


@app.post("/analyze_thought")
def analyze_thought(payload: EntryPayload) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    
    # Generate Embedding
    try:
        vector = vectorize(full_text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Embedding error: {exc}")

    # Classifications
    drift_label = classify_drift(payload.automatic_thought)
    
    w_res = classifier(full_text, WELLNESS_LABELS)
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
            
            now_dt = datetime.fromisoformat(payload.timestamp).replace(tzinfo=timezone.utc) if payload.timestamp else datetime.now(timezone.utc)
            cutoff_7d = now_dt - timedelta(days=7)
            
            new_tags_set = {t.lower().strip() for t in payload.context_tags}
            
            for i, r in enumerate(rows):
                sim = float(sims[i])
                hist_id = r["id"]
                preview = r["automatic_thought"][:120]
                hist_tags = {t.lower().strip() for t in json.loads(r["context_tags"] or "[]")}
                
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
                    
        # Sort and limit candidates
        compensatory_links = sorted(compensatory_links, key=lambda x: x["similarity"], reverse=True)[:3]
        
        clean_tags = [t.strip().lower() for t in (payload.context_tags or []) if t.strip()]
        contextual_links = find_contextual_chain_link(conn, clean_tags, None)

        threshold = compute_adaptive_threshold(conn)
        semantic_proposals = find_semantic_chain_link(
            conn, vector, None, threshold
        )
        
        # Rumination Guard check (do not trigger save, check only)
        rumination_res = check_rumination(conn, vector, full_text)
        
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
            "wellness_score": float(round(wellness_score, 4)),
            "cognitive_drift": float(round(cd_score, 4))
        },
        "rumination": {
            "rumination_detected": rumination_res["rumination_detected"],
            "flag_count": rumination_res["flag_count"]
        },
        "proposed_links": {
            "semantic": semantic_proposals,
            "compensatory": compensatory_links,
            "contextual": contextual_links
        },
        "reduction_applied": True,
    }

@app.post("/benchmark_analyze")
def benchmark_analyze(payload: EntryPayload) -> dict[str, Any]:
    """
    Identical to /analyze_thought but wraps key processes in timers
    and returns the timings in the response payload.
    """
    import time
    
    t_start = time.perf_counter()
    full_text = _format_full_text(payload)
    
    # Generate Embedding
    t_emb_start = time.perf_counter()
    vector = vectorize(full_text)
    t_emb_end = time.perf_counter()
    
    # Classifications
    drift_label = classify_drift(payload.automatic_thought)
    t_drift_end = time.perf_counter()
    
    w_res = classifier(full_text, WELLNESS_LABELS)
    wellness_label = w_res["labels"][0]
    wellness_score = w_res["scores"][0]
    t_infer_end = time.perf_counter()
    
    conn = get_connection()
    t_faiss_start = time.perf_counter()
    try:
        cursor = conn.cursor()
        
        rows = cursor.execute(
            "SELECT id, vector_embedding, timestamp, situation, automatic_thought, context_tags, entry_type, wellness_label FROM drift_nodes WHERE user_id = ?",
            (payload.user_id,)
        ).fetchall()
        
        compensatory_links = []
        contextual_links = []
        adaptive_threshold = 0.75 
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
            
            sims = np.dot(all_np, curr_np[0])
            mu = float(np.mean(sims))
            sigma = float(np.std(sims))
            adaptive_threshold = max(0.50, min(0.95, mu + sigma))
            
            all_time_mean = np.mean(all_np, axis=0)
            norm_all = np.linalg.norm(all_time_mean)
            if norm_all > 0:
                dot_p = np.dot(curr_np[0], all_time_mean)
                cd_score = 1.0 - max(0.0, min(1.0, dot_p / norm_all))
            
            now_dt = datetime.fromisoformat(payload.timestamp).replace(tzinfo=timezone.utc) if payload.timestamp else datetime.now(timezone.utc)
            cutoff_7d = now_dt - timedelta(days=7)
            new_tags_set = {t.lower().strip() for t in payload.context_tags}
            
            for i, r in enumerate(rows):
                sim = float(sims[i])
                hist_id = r["id"]
                preview = r["automatic_thought"][:120]
                hist_tags = {t.lower().strip() for t in json.loads(r["context_tags"] or "[]")}
                
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
                    
        compensatory_links = sorted(compensatory_links, key=lambda x: x["similarity"], reverse=True)[:3]
        
        clean_tags = [t.strip().lower() for t in (payload.context_tags or []) if t.strip()]
        contextual_links = find_contextual_chain_link(conn, clean_tags, None)
        
        threshold = compute_adaptive_threshold(conn)
        semantic_proposals = find_semantic_chain_link(
            conn, vector, None, threshold
        )
        
        rumination_res = check_rumination(conn, vector, full_text)
        
    except sqlite3.Error as exc:
        log.error("DB error in benchmark_analyze: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")
    finally:
        conn.close()
        
    t_faiss_end = time.perf_counter()
    
    t_end_total = time.perf_counter()
    
    return {
        "timings": {
            "embedding_time_ms": (t_emb_end - t_emb_start) * 1000,
            "drift_time_ms": (t_drift_end - t_emb_end) * 1000,
            "wellness_time_ms": (t_infer_end - t_drift_end) * 1000,
            "faiss_retrieval_time_ms": (t_faiss_end - t_faiss_start) * 1000,
            "total_internal_time_ms": (t_end_total - t_start) * 1000
        },
        "classification": {
            "drift_label": drift_label,
            "drift_score": 1.0, 
            "wellness_label": wellness_label,
            "wellness_score": float(round(wellness_score, 4)),
            "cognitive_drift": float(round(cd_score, 4))
        },
        "rumination": {
            "rumination_detected": rumination_res["rumination_detected"],
            "flag_count": rumination_res["flag_count"]
        },
        "proposed_links": {
            "semantic": semantic_proposals,
            "compensatory": compensatory_links,
            "contextual": contextual_links
        },
        "reduction_applied": True,
        "adaptive_threshold": float(round(adaptive_threshold, 4))
    }


def run_zero_shot_analysis(node_id: int, user_id: int, full_text: str, automatic_thought: str, vector: list[float], timestamp: str | None) -> None:
    try:
        # Zero-shot classifications
        drift_label = classify_drift(automatic_thought)
        
        w_res = classifier(full_text, WELLNESS_LABELS)
        wellness_label = w_res["labels"][0]
        
        # Connect to DB and update the node
        conn = get_connection()
        try:
            # check_rumination logic needs db connection
            rumination_res = check_rumination(conn, vector, full_text)
            flag_count = safe_int(rumination_res["flag_count"])
            cosine_sim = safe_float(rumination_res.get("similarity_to_mean", 0.0))
            
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE drift_nodes
                SET cognitive_drift = ?,
                    wellness_label = ?,
                    rumination_flag_count = ?,
                    similarity_score = ?
                WHERE id = ?
            """, (drift_label, wellness_label, flag_count, cosine_sim, node_id))
            conn.commit()
            log.info("Background analysis complete for node %d.", node_id)
        except Exception as inner_exc:
            log.error("Database error in background task for node %d: %s", node_id, inner_exc)
        finally:
            conn.close()
            
    except Exception as exc:
        log.error("Background task failed for node %d: %s", node_id, exc)

@app.post("/save_thought")
def save_thought(payload: SaveEntryPayload, background_tasks: BackgroundTasks) -> dict[str, Any]:
    full_text = _format_full_text(payload)
    timestamp = payload.timestamp if payload.timestamp else datetime.now(timezone.utc).isoformat()
    
    # Recalculate Fast Path (Synchronous)
    vector = vectorize(full_text)
    
    belief_shift = 0
    if payload.thought_belief_before is not None and payload.thought_belief_after is not None:
        belief_shift = payload.thought_belief_before - payload.thought_belief_after

    raw_tags = payload.context_tags or []
    clean_tags = json.dumps(
        [t.strip().lower() for t in raw_tags if t.strip()]
    )

    conn = get_connection()
    try:
        cursor = conn.cursor()
        
        # Insert node with pending values for heavy NLP tasks
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
                "Analyzing...",
                clean_tags,
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
    }


# ── GET /get_graph_data ───────────────────────────────────────────────────────
@app.get("/get_graph_data")
async def get_graph_data() -> dict[str, list[dict]]:
    """
    Return all nodes (without their heavyweight vector embeddings) and all
    links, ready for D3.js consumption.
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, timestamp, situation, automatic_thought, cognitive_drift, context_tags, rumination_flag_count, similarity_score, wellness_label,
                   entry_type, thought_belief_before, emotion, emotion_intensity, evidence_for, evidence_against, reframed_thought, thought_belief_after, belief_shift
            FROM drift_nodes
            ORDER BY id ASC
            """
        )
        nodes = []
        for row in cursor.fetchall():
            nodes.append({
                "id":               row["id"],
                "date":        row["timestamp"],
                "situation":        row["situation"],
                "text":    row["automatic_thought"],
                "cognitive_drift":  row["cognitive_drift"],
                "wellness":         row["wellness_label"] or "neutral reflection",
                "tags":     json.loads(row["context_tags"] or "[]"),
                "rumination_flag": safe_int(row["rumination_flag_count"]),
                "similarity_score": safe_float(row["similarity_score"]),
                
                # New fields for structured diaries
                "entry_type":            row["entry_type"] if row["entry_type"] is not None else "free_form",
                "details": {
                    "thought_belief_before": row["thought_belief_before"],
                    "emotion":               row["emotion"],
                    "emotion_intensity":     row["emotion_intensity"],
                    "evidence_for":          row["evidence_for"],
                    "evidence_against":      row["evidence_against"],
                    "reframed_thought":      row["reframed_thought"],
                    "thought_belief_after":  row["thought_belief_after"],
                    "belief_shift":          row["belief_shift"],
                }
            })

        cursor.execute(
            "SELECT id, source_id, target_id, link_type, details, verified FROM drift_links ORDER BY id ASC"
        )
        links = []
        for row in cursor.fetchall():
            links.append({
                "id":        row["id"],
                "source":    row["source_id"],
                "target":    row["target_id"],
                "link_type": row["link_type"],
                "details":   row["details"] or "",
                "verified":  row["verified"] if row["verified"] is not None else 0,
            })

    except sqlite3.Error as exc:
        log.error("Database error on GET: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}") from exc
    finally:
        conn.close()

    log.info("GET /get_graph_data — %d nodes, %d links", len(nodes), len(links))
    return {"nodes": nodes, "links": links}

# ── GET /drift/weekly ─────────────────────────────────────────────────────────
@app.get("/drift/weekly")
async def get_weekly_drift(user_id: int = 1) -> list[dict]:
    """
    Returns Weekly Cognitive Drift: 1 - cosine_similarity(weekly_mean, all_time_mean)
    High drift represents exploring new territory.
    """
    conn = get_connection()
    try:
        cursor = conn.cursor()
        
        # 1. Fetch all vector embeddings and their timestamps for the user
        rows = cursor.execute(
            "SELECT timestamp, vector_embedding FROM drift_nodes WHERE user_id = ? ORDER BY timestamp ASC",
            (user_id,)
        ).fetchall()
        
        if not rows:
            return []
            
        all_embeddings = []
        weeks_map = {} # Maps "YYYY-WXX" to list of embeddings
        
        for r in rows:
            emb = json.loads(r["vector_embedding"])
            all_embeddings.append(emb)
            
            # Parse the ISO datetime string, e.g. "2026-02-23T15:38:16+05:30"
            dt = datetime.fromisoformat(r["timestamp"])
            iso_year, iso_week, _ = dt.isocalendar()
            week_label = f"{iso_year}-W{iso_week:02d}"
            
            if week_label not in weeks_map:
                weeks_map[week_label] = []
            weeks_map[week_label].append(emb)
            
        if not all_embeddings:
            return []
            
        all_embeddings_np = np.array(all_embeddings, dtype=np.float32)
        all_time_mean = np.mean(all_embeddings_np, axis=0)
        norm_all_time = np.linalg.norm(all_time_mean)
        
        if norm_all_time == 0:
            return []
            
        # 2. Iterate each week chronologically and calculate cosine distance from the grand mean
        results = []
        sorted_weeks = sorted(weeks_map.keys())
        
        for w_label in sorted_weeks:
            week_embs_np = np.array(weeks_map[w_label], dtype=np.float32)
            weekly_mean = np.mean(week_embs_np, axis=0)
            
            norm_weekly = np.linalg.norm(weekly_mean)
            
            if norm_weekly > 0:
                dot_product = np.dot(weekly_mean, all_time_mean)
                cosine_sim = dot_product / (norm_weekly * norm_all_time)
                # Cap between 0 and 1 defensively
                cosine_sim = max(0.0, min(1.0, cosine_sim))
                drift_score = 1.0 - cosine_sim
            else:
                drift_score = 0.0
                
            results.append({
                "week": w_label,
                "drift_score": float(round(drift_score, 4))
            })
            
        return results
        
    except sqlite3.Error as exc:
        log.error("Database error on /drift/weekly GET: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}") from exc
    finally:
        conn.close()

# ── GET /export_report ───────────────────────────────────────────────────────────────
@app.get("/export_report", response_class=PlainTextResponse)
async def export_report() -> PlainTextResponse:
    """
    Generate a Markdown-formatted cognitive drift report for all logged thoughts
    and return it as a downloadable .md file.
    """
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT timestamp, situation, automatic_thought, cognitive_drift, context_tags
            FROM drift_nodes
            ORDER BY timestamp DESC
            """
        ).fetchall()
    except sqlite3.Error as exc:
        log.error("Database error on export: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}") from exc
    finally:
        conn.close()

    # ── Statistics ───────────────────────────────────────────────────────────────
    total = len(rows)
    drift_freq: dict[str, int] = {}
    for row in rows:
        drift = row["cognitive_drift"]
        if drift and drift != "None":
            drift_freq[drift] = drift_freq.get(drift, 0) + 1

    # Sort drift types high → low
    sorted_drifts = sorted(drift_freq.items(), key=lambda x: x[1], reverse=True)

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # ── Build Markdown ───────────────────────────────────────────────────────────────
    lines: list[str] = [
        "# Cognitive Drift Analysis Report",
        "",
        f"_Generated: {generated_at}_",
        "",
        "## Summary Statistics",
        "",
        f"- **Total thoughts logged:** {total}",
    ]

    if sorted_drifts:
        lines.append("- **Drift types detected:**")
        for drift_type, count in sorted_drifts:
            lines.append(f"  - {drift_type}: {count} time{'s' if count != 1 else ''}")
    else:
        lines.append("- **Drift types detected:** None")

    lines += [
        "",
        "## Detailed Log",
        "",
    ]

    for row in rows:
        # Parse timestamp to a readable date
        try:
            dt = datetime.fromisoformat(row["timestamp"])
            date_str = dt.strftime("%Y-%m-%d %H:%M UTC")
        except ValueError:
            date_str = row["timestamp"]

        tags_raw = json.loads(row["context_tags"] or "[]")
        tags_str = ", ".join(tags_raw) if tags_raw else "_none_"

        lines += [
            f"### {date_str}",
            "",
            f"**Situation:** {row['situation']}",
            "",
            f"**Automatic Thought:** {row['automatic_thought']}",
            "",
            f"**Detected Drift:** {row['cognitive_drift']}",
            "",
            f"**Context Tags:** {tags_str}",
            "",
            "---",
            "",
        ]

    report_md = "\n".join(lines)

    log.info("GET /export_report — %d entries exported.", total)
    return PlainTextResponse(
        content=report_md,
        media_type="text/markdown",
        headers={"Content-Disposition": "attachment; filename=cognitive_drift_report.md"},
    )


# ── Dev entry-point ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8001, reload=True)
