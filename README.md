# Cognitive Drift Detection System (Cognitive Canvas)

A local-first, privacy-centric web application for cognitive journaling, emotion tracking, and CBT-influenced reflection. The system uses local NLP models to classify cognitive patterns, detect rumination, and build a semantic, force-directed graph of a user's thought history.

**Disclaimer:** Cognitive Canvas is a self-awareness tool, not a clinical diagnostic service.

## Architecture

*   **Backend:** FastAPI (Python), SQLite3, FAISS (Vector Database)
*   **NLP & ML:** Hugging Face `sentence-transformers` (`BAAI/bge-large-en-v1.5`), `transformers` pipeline (`facebook/bart-large-mnli` for cognitive drift, `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` for wellness categorization)
*   **Frontend:** Vanilla JS, HTML, CSS Grid (4-panel layout), D3.js v7 (Narrative Timeline Visualization)

## Core Features

### 1. Human-in-the-Loop (HITL) Journaling Flow
The system splits journaling into a two-step process:
1. **Analysis (`/analyze_thought`):** Computes embeddings, runs zero-shot models, sets adaptive thresholds, and proposes potential graph links.
2. **Review & Save (`/save_thought`):** Users review AI-proposed links via a modal interface. Only approved links and auto-verified chronological links are committed to the graph.

### 2. Zero-Shot Cognitive Drift Detection
When a user logs a freeform thought, the backend runs a zero-shot classification pipeline against common cognitive distortions (e.g., Catastrophizing, All-or-nothing thinking). This flags "cognitive drift" automatically.

### 3. Semantic Narrative Timeline (D3.js)
Thoughts are embedded into high-dimensional vectors and stored in a FAISS index. The UI renders a structured "Narrative Timeline" using a hybrid organic physics engine. Nodes are strictly locked to a chronological X-Axis to prevent "hairball" clumping, while memory connections sweep over the timeline as beautiful SVG Bezier curves. There are three distinct, user-toggleable AI link layers:
*   **Contextual Links:** Thoughts that share at least 2 context tags. (Purple)
*   **Semantic Links:** Thoughts sharing high cosine similarity, utilizing an adaptive user-specific threshold (`mu + sigma`). (Cyan)
*   **Compensatory Links:** Connects thoughts with flipped wellness polarities (e.g., negative distress to positive growth) occurring within a 7-day window with semantic similarity `>= 0.55`. (Amber)

### 4. Intelligent Intersection Search
The floating Command Center allows users to text-search their memories. The interface dynamically dims non-matching nodes. Crucially, if a memory layer is toggled on, connecting arcs are *only* drawn if **both** the source and target nodes match the search query, instantly cutting through visual noise.

### 5. Rumination Guard
The system monitors for repetitive, entrenched thinking. It checks the user's latest embedding against a historical mean and flags the entry if it correlates highly and the DeBERTa model detects "negative distress". If this pattern loops, the backend flags it as "rumination" and the frontend interrupts the user with a wellbeing modal containing cognitive defusion prompts.

### 6. CBT Thought Diary Wizard & Notion Modals
A structured, multi-step entry mode mirroring a Cognitive Behavioral Therapy (CBT) thought record:
*   **Steps:** Situation -> First Thought (Belief %) -> Emotion (Intensity %) -> Evidence For -> Evidence Against -> Reframed Thought (Revised Belief %).
*   **Belief Shift:** Calculates the mathematical shift in belief before and after the exercise.
*   **Visualization:** Clicking any standard date-pill node will slide out a gorgeous Notion-style metadata panel showcasing the entry breakdown, AI correlations, and detected cognitive drift.

## API Endpoints (`app.py`)

*   `POST /analyze_thought`: Analyzes entries and returns proposed links and classifications for review.
*   `POST /save_thought`: Commits the verified thought to the database alongside approved links.
*   `GET /get_graph_data`: Returns the full topology (`nodes` and `links`) formatted for D3.js rendering. Includes strict data reshaping.
*   `GET /drift/weekly`: Computes week-over-week temporal embedding variances for analytics.

## Running Locally

1.  **Install Dependencies:**
    ```bash
    pip install fastapi uvicorn sqlite3 sentence-transformers transformers faiss-cpu pydantic numpy
    ```
2.  **Environment Configuration:**
    The application defaults Hugging Face caching to `D:/huggingface` to prevent `C:/` drive overflow. Ensure the `D:/` drive exists or modify `app.py` environment variables if running on a different machine.
3.  **Start the Server:**
    ```bash
    uvicorn app:app --reload --port 8000
    ```
4.  **Client:**
    Open `index.html` via a local web server (e.g. `python -m http.server 8080`) in a modern web browser.

## Data Schema (`drift_v2.db`)

**`drift_nodes`**
*   `id`, `user_id`, `timestamp`, `entry_type` ("free_form" or "thought_diary")
*   `situation`, `automatic_thought` / `first_thought`, `emotion`, `context_tags`
*   `cognitive_drift`, `vector_embedding`, `rumination_flag_count`, `wellness_label`, `similarity_score`
*   *(Thought Diary fields)*: `thought_belief_before`, `emotion_intensity`, `evidence_for`, `evidence_against`, `reframed_thought`, `thought_belief_after`, `belief_shift`

**`drift_links`**
*   `id`, `source_id`, `target_id`, `link_type`, `details`, `verified`
