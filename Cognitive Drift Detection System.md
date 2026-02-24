# Cognitive Drift Detection System 

**Project Type:** Final Year Computer Science Engineering Project  
**Status:** V2 (Active)

## 📌 Project Overview
The Cognitive Drift Detection System is a local-first, AI-powered spatial mapping tool designed for high-functioning individuals to analyze their thought patterns. Moving beyond traditional chronological journaling, this system utilizes natural language processing (NLP), zero-shot classification, and indexed vector search to automatically detect logic drifts and map semantic relationships between entries.

By running entirely on local hardware, the system ensures absolute data privacy while delivering production-grade AI insights.

## 🏗️ Architecture & Tech Stack
The application is decoupled into a lightweight vanilla frontend and a heavy-lifting AI backend.

* **Frontend:** Vanilla HTML5, CSS3 (Dark Mode), Vanilla JavaScript, D3.js (v7) for force-directed network rendering, and Chart.js for trend analytics.
* **Backend:** Python 3, FastAPI, SQLite3.
* **Machine Learning Pipeline (Local Hugging Face):**
    * **Vectorization:** `BAAI/bge-large-en-v1.5` (Generates 1024-dimensional semantic embeddings).
    * **Invisible AI (Zero-Shot):** `facebook/bart-large-mnli` (Automatically categorizes text into drift categories without manual user input).
    * **Vector Database:** `FAISS` (Facebook AI Similarity Search) for $O(\log N)$ nearest-neighbor semantic retrieval.

## 🚀 Core Features

1. **Invisible AI Classification:** Users simply type their thoughts. The backend zero-shot classifier automatically detects underlying cognitive drifts (e.g., "Outcome Magnification", "Identity Fusion") without requiring clinical jargon.
2. **FAISS-Powered Semantic Mapping:** The system calculates relationships between thoughts using three mathematical thresholds:
   * **Contextual Links:** Explicit tag overlap ($\ge 2$ tags).
   * **Semantic Links:** FAISS-indexed Cosine Similarity ($> 0.78$) across 1024D vectors.
   * **Compensatory Links:** Rapid emotional/narrative shifts detected within a 7-day window.
3. **The Rumination Guard:** An algorithmic safety mechanism that detects dense, highly similar negative thought clusters within a 24-hour window and triggers a pattern-interrupt warning.
4. **Command Center Analytics:** Interactive UI featuring D3.js wire-toggling, Chart.js emotional intensity tracking, and interactive hover-tooltips for algorithm transparency.
5. **Markdown Export Engine:** Automatically generates formatted `.md` reports summarizing drift frequencies and providing plain-English psychological insights for offline review.

## ⚙️ Installation & Setup

1. **Clone the repository.**
2. **Set up the Python environment:**
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows: venv\Scripts\activate
    pip install fastapi uvicorn sqlite3 sentence-transformers transformers torch faiss-cpu numpy
    ```
3. **Run the local server:**
    ```bash
    uvicorn app:app --reload
    ```
4. **Launch the App:** Open `index.html` directly in any modern web browser.

## 🔬 Academic Note
This project was designed as a technical exploration of applying spatial semantic mapping and local-first vector databases to personal narrative data. It is an analytical tool, not a clinical diagnostic device.