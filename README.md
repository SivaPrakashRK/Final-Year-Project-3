# Cognitive Drift Detection System (Cognitive Canvas)

A local-first, privacy-centric web application for cognitive journaling, emotion tracking, and CBT-influenced reflection. The system uses local NLP models to classify cognitive distortions, detect rumination patterns, and build a semantic, force-directed graph of a user's thought history.

## Architecture

*   **Backend:** FastAPI (Python), SQLite3, FAISS (Vector Database)
*   **NLP & ML:** Hugging Face `sentence-transformers` (`BAAI/bge-large-en-v1.5`) & `transformers` pipeline (`facebook/bart-large-mnli`)
*   **Frontend:** Vanilla HTML/CSS/JS, D3.js (Graph Visualization), Chart.js (Analytics)

## Core Features

### 1. Zero-Shot Cognitive Drift Detection
When a user logs a freeform thought, the backend runs a zero-shot classification pipeline (`facebook/bart-large-mnli`) against common CBT cognitive distortions (e.g., Catastrophizing, All-or-nothing thinking, Mind reading). This flags "cognitive drift" automatically without requiring a clinical dataset.

### 2. Semantic Graphing (D3.js)
Thoughts are embedded into high-dimensional vectors (using `bge-large-en-v1.5`) and stored in a FAISS index. The system maps relationships between thoughts to render a force-directed graph with three distinct link types:
*   **Context Links:** Thoughts logged within 1 hour of each other that share at least 2 context tags. (Blue/Teal)
*   **Semantic Links:** Thoughts with a high mathematical cosine similarity threshold (`>= 0.78`). (Amber)
*   **Compensatory Links:** Highlights emotional whiplash. Connects thoughts with flipped emotional polarities (e.g., highly negative to highly positive) occurring within a 7-day window with strong semantic similarity (`>= 0.70`). (Red/Violet)

### 3. Rumination Guard
The system constantly monitors for repetitive, entrenched thinking. If a new thought mathematically matches (`cosine_sim >= 0.85`) 3 or more previous thoughts within the last 24 hours, the backend flags it as "rumination". The frontend will gently interrupt the user with a wellbeing modal, suggesting they step away or break the cycle if they are dwelling.

### 4. CBT Thought Diary Wizard
A structured, multi-step entry mode mirroring a Cognitive Behavioral Therapy (CBT) thought record:
*   **Steps:** Situation -> First Thought (Belief %) -> Emotion (Intensity %) -> Evidence For -> Evidence Against -> Reframed Thought (Revised Belief %).
*   **Belief Shift:** Calculates the mathematical shift in belief before and after the exercise.
*   **Visualization:** Represented on the D3 graph as explicitly scaled **Diamond** nodes (scaling directly with the positive `belief_shift`), distinct from standard freeform circles. Negative shifts are highlighted with red-amber borders.

### 5. Trend Analytics & Reporting
*   **Weekly Drift Analysis:** Calculates a weekly "cognitive drift score" mathematically driven by the distance of weekly thought embeddings against the user's all-time structural mean. Visualized via a Chart.js bar graph.
*   **Markdown Export:** Generates a downloadable `.md` file detailing all historical entries, timestamps, identified cognitive drifts, and summary statistics.

## API Endpoints (`app.py`)

*   `POST /log_thought`: Ingests freeform entries. Detects emotion, flags drift, builds vectors, finds FAISS semantic neighbors, generates graph links, and evaluates rumination guard thresholds.
*   `POST /log_thought_diary`: Ingests structured 6-step CBT diary entries. Computes `belief_shift` alongside standard drift and graph processing.
*   `GET /get_graph_data`: Returns the full topology (`nodes` and `links`) formatted for D3.js rendering. Includes strict data reshaping (e.g., mapping `automatic_thought` to `first_thought` for clinical distancing).
*   `GET /drift/weekly`: Computes week-over-week temporal embedding variances for the Chart.js visualizer.
*   `GET /export_report`: Downloads the user's entire history as a formatted Markdown timeline.

## Running Locally

1.  **Install Dependencies:**
    ```bash
    pip install fastapi uvicorn sqlite3 sentence-transformers transformers faiss-cpu pydantic numpy
    ```
2.  **Environment Configuration:**
    The application defaults Hugging Face caching to `D:/huggingface` to prevent `C:/` drive overflow. Ensure the `D:/` drive exists or modify `app.py` environment variables if running on a different machine.
3.  **Start the Server:**
    ```bash
    python app.py
    ```
    *(Alternatively: `uvicorn app:app --host 0.0.0.0 --port 8000 --reload`)*
4.  **Client:**
    Open `index.html` in a modern web browser. No frontend build step or package manager is required.

## Data Schema (`drift_v2.db`)

**`drift_nodes`**
*   `id`, `user_id`, `timestamp`, `entry_type` ("free_form" or "thought_diary")
*   `situation`, `automatic_thought` / `first_thought`, `emotion`, `context_tags`
*   `cognitive_drift`, `vector_embedding`, `rumination_flag_count`
*   *(Thought Diary fields)*: `thought_belief_before`, `emotion_intensity`, `evidence_for`, `evidence_against`, `reframed_thought`, `thought_belief_after`, `belief_shift`

**`drift_links`**
*   `id`, `source_id`, `target_id`, `link_type`, `similarity_score`, `details`
