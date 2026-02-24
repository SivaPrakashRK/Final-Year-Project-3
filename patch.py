
import re
import os

app_path = r"d:\College\Final Year Project 3\app.py"
endpoints_path = r"d:\College\Final Year Project 3\new_endpoints.py"

with open(app_path, "r", encoding="utf-8") as f:
    app_text = f.read()

with open(endpoints_path, "r", encoding="utf-8") as f:
    endpoints_text = f.read()

# Replace the two old POST endpoints
# We look for the start of `def log_thought(payload: ThoughtPayload)` or `@app.post("/log_thought")`
# and the end of `def log_thought_diary` function.
# An easier way is to use regex.
pattern = re.compile(
    r"# ── POST /log_thought ─────────────────────────────────────────────────────────\n"
    r"@app\.post\(\"/log_thought\"\).*?"
    r"# ── GET /get_graph_data ───────────────────────────────────────────────────────\n",
    re.DOTALL
)

if not pattern.search(app_text):
    print("Could not find the endpoints block to replace!")
else:
    new_text = app_text.replace(
        pattern.search(app_text).group(0),
        "# ── POST /analyze_thought & /save_thought ───────────────────────────────────\n" +
        endpoints_text + "\n\n" +
        "# ── GET /get_graph_data ───────────────────────────────────────────────────────\n"
    )

    # 1. Update GET /get_graph_data to include `verified`
    # Replace the SELECT
    select_old = '"SELECT id, source_id, target_id, link_type, details FROM drift_links ORDER BY id ASC"'
    select_new = '"SELECT id, source_id, target_id, link_type, details, verified FROM drift_links ORDER BY id ASC"'
    new_text = new_text.replace(select_old, select_new)

    # Replace the links.append
    append_old = """            links.append({
                "id":        row["id"],
                "source":    row["source_id"],
                "target":    row["target_id"],
                "link_type": row["link_type"],
                "details":   row["details"] or "",
            })"""
    
    append_new = """            links.append({
                "id":        row["id"],
                "source":    row["source_id"],
                "target":    row["target_id"],
                "link_type": row["link_type"],
                "details":   row["details"] or "",
                "verified":  row["verified"] if row["verified"] is not None else 0,
            })"""
    new_text = new_text.replace(append_old, append_new)

    # 2. Update /drift/weekly return key: "week_label" -> "week" (requested by user "week: '2025-W03'")
    new_text = new_text.replace('"week_label": w_label', '"week": w_label')

    with open(app_path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("Successfully patched app.py")
