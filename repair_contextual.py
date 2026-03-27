"""
repair_contextual.py
Applies transitive-reduction cleanup to ALL contextual links in the DB.

Rule: for each (source_id, tag) pair, only the link to the MOST RECENT
previous node that carries that tag should survive.  Every other contextual
link originating from that source is a transitive-redundant shortcut and
gets deleted.
"""
import sqlite3
import json

DB = "drift_v2.db"

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Load every node's tag set (id → set of normalised tags)
nodes = {
    r["id"]: {t.strip().lower() for t in json.loads(r["context_tags"] or "[]") if t.strip()}
    for r in conn.execute("SELECT id, context_tags FROM drift_nodes ORDER BY id ASC").fetchall()
}

# Load all contextual links ordered by source ASC, target DESC
# (so for each source we iterate its targets newest-first)
ctx_links = conn.execute(
    "SELECT id, source_id, target_id FROM drift_links WHERE link_type = 'contextual' ORDER BY source_id ASC, target_id DESC"
).fetchall()

to_delete = []

# For each source node, work out which single target to keep per tag
for source_id in sorted({r["source_id"] for r in ctx_links}):
    source_tags = nodes.get(source_id, set())
    if not source_tags:
        continue

    # Candidate links for this source, ordered from most-recent to oldest target
    candidates = [r for r in ctx_links if r["source_id"] == source_id]

    tag_claimed = {}   # tag → target_id that claimed it first (most recent)
    keep_ids = set()

    for row in candidates:
        tgt = row["target_id"]
        tgt_tags = nodes.get(tgt, set())
        shared = source_tags & tgt_tags
        new_tags = {t for t in shared if t not in tag_claimed}

        if new_tags:
            for tag in new_tags:
                tag_claimed[tag] = tgt
            keep_ids.add(row["id"])
        else:
            # This link adds no new tag coverage → transitive redundancy
            to_delete.append(row["id"])

print(f"Links to keep  : {len(ctx_links) - len(to_delete)}")
print(f"Links to delete: {len(to_delete)}")
if to_delete:
    for lid in to_delete:
        print(f"  Deleting link id={lid}")
    conn.executemany("DELETE FROM drift_links WHERE id = ?", [(i,) for i in to_delete])
    conn.commit()
    print("Done.")
else:
    print("No redundant contextual links found — DB is already clean.")

conn.close()
