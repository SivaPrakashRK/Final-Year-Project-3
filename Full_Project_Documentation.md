---

# Cognitive Canvas: AI-Powered Local-First Spatial 
# Journaling System

**Status:** Active V2  
**Disclaimer:** Cognitive Canvas is a self-awareness 
wellness tool, not a clinical diagnostic service.

## Overview
Cognitive Canvas is a privacy-first, local-first 
spatial journaling system that transforms free-form 
text entries into an interactive directed knowledge 
graph entirely on consumer-grade hardware. No user 
data traverses a network boundary at any stage. 
The system maps Cognitive Drift — a mathematically 
defined measure of semantic change over time — 
without assigning pathological labels or diagnosing 
psychological conditions.

## Architecture

- **Frontend:** Vanilla HTML5, CSS3, JavaScript, 
  D3.js v7
- **Backend:** Python 3, FastAPI, SQLite3
- **Vector Store:** sqlite-vec (embedded vector 
  database, replaces FAISS for OLTP workloads)
- **Embedding Model:** BAAI/bge-large-en-v1.5 
  (1024-dimensional semantic vectors)
- **Classification Model:** 
  MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli 
  (zero-shot wellness and drift classification)

## Core Features

### 1. Dual-Mode Journaling Interface
Two entry modes are supported:

**Freeform:** Open text entry. The user writes 
freely with optional context tags.

**Evidence and Reframe Thought Diary:** A six-prompt 
structured self-reflection sequence:
  1. What was the situation?
  2. What was your first thought? (belief % before)
  3. What did you feel? (intensity %)
  4. Evidence supporting this thought
  5. Evidence against this thought
  6. A more balanced perspective (belief % after)

The system calculates a Belief Shift metric 
(belief_before - belief_after) which is stored 
per entry and visualised as node size in the graph.

### 2. Adaptive Min-P Semantic Thresholding
Rather than a fixed cosine threshold, the system 
computes a user-adaptive threshold:

  T_adaptive = μ_user + σ_user

Where μ and σ are the mean and standard deviation 
of pairwise cosine similarities across all entries 
by that user, recomputed incrementally using 
Welford's online algorithm at O(1) cost per insert.

### 3. Tripartite Semantic Chain Linking
Three directed link types connect entries:

**Semantic Chain Links (Cyan):** For each new 
entry, the system walks backwards through history 
in reverse chronological order. It creates a 
single directed edge to the first predecessor 
exceeding T_adaptive. Search terminates immediately. 
Each entry has at most one semantic predecessor — 
producing chains, not webs.

**Contextual Chain Links (Purple):** A directed 
edge connects the new entry to the most recent 
prior entry sharing at least one user-assigned tag. 
At most one contextual link per entry. Uses 
Python-side JSON array parsing for reliable tag 
matching regardless of whitespace formatting.

**Compensatory Links (Amber):** Connects entries 
with opposing wellness polarity (negative distress 
↔ positive growth) occurring within a 7-day window 
with cosine similarity ≥ 0.70. Surfaces emotional 
oscillation patterns.

### 4. Human-in-the-Loop Link Verification
AI-proposed links are never saved automatically.

- POST /analyze_thought: Generates embedding, 
  classifies entry, finds proposed links. 
  No database writes.
- POST /save_thought: Saves only the links 
  explicitly approved by the user in the 
  verification modal. Chronological links are 
  the sole auto-verified exception.

### 5. Cognitive Drift Detection
A non-pathological drift metric tracks semantic 
change over time:

  CD(W) = 1 - cos(μ_W, μ_global)

Where μ_W is the centroid of embeddings in the 
current 7-day window and μ_global is the global 
centroid. Values approaching 0 indicate topical 
consistency; values approaching 1 indicate 
maximal semantic divergence. No pathological 
labels are applied.

### 6. Rumination Guard
Monitors for sustained semantic loops co-occurring 
with negative affect:
- Compares new entry against mean of N=5 most 
  recent embeddings
- Similarity threshold: T_sim = 0.88
- Negative valence threshold: P_neg = 0.70
- Trigger requirement: K=3 consecutive entries 
  meeting both conditions
- On trigger: presents a non-clinical wellness 
  reflection prompt, resets counter to 0

### 7. Progressive Disclosure Graph Architecture
The D3.js graph defaults to showing only the 
chronological spine (dashed white wires). AI wire 
layers are hidden until the user explicitly 
toggles them via the Command Center:
  - Show Semantic Flashbacks (cyan)
  - Show Pendulum Swings / Compensatory (amber)
  - Show Shared Context / Contextual (purple)

Search dims all non-matching nodes to 0.06 
opacity. Links only render between matched nodes.

Clicking any node opens a Notion-style slide-out 
panel showing the full entry content, belief 
shift bar, classification badges, and connected 
entries with link type indicators.

## API Endpoints

- POST /analyze_thought — analysis only, no writes
- POST /save_thought — persists with approved links
- GET /get_graph_data — full graph topology for D3
- GET /drift/weekly — weekly drift scores

## Ethical Positioning

Cognitive Canvas deliberately avoids:
- Generative LLM inference (no hallucination risk)
- Clinical diagnostic labels
- Cloud transmission of any user data
- Automatic persistence of AI-inferred connections

All AI outputs are deterministic similarity scores 
with mathematical provenance that users can inspect 
and contest.

---
