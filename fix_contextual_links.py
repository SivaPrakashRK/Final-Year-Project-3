import sqlite3
import json
import itertools
from collections import defaultdict

def fix_contextual_links():
    conn = sqlite3.connect('drift_v2.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all nodes ordered by ID (chronological)
    rows = cursor.execute('SELECT id, context_tags FROM drift_nodes ORDER BY id ASC').fetchall()
    
    # Clear existing contextual links to cleanly recreate them
    cursor.execute('DELETE FROM drift_links WHERE link_type = "contextual"')
    deleted = cursor.rowcount
    print(f"Deleted {deleted} old contextual links.")
    
    # To implement "transitive reduction" chronologically for each tag:
    # A node should only link to the most recent previous node that shares the tag.
    # E.g., if Node 5 has #exams, it links to Node 4 (if Node 4 has #exams), and NOT Node 1.
    
    # Map each tag to the ID of the most recent node that had this tag
    last_seen_tag = {}
    
    links_to_add = set() # (source, target, tag)
    
    for row in rows:
        node_id = row['id']
        try:
            raw_tags = json.loads(row['context_tags'] or '[]')
            if not isinstance(raw_tags, list):
                raw_tags = []
        except:
            raw_tags = []
            
        tags = set(t.lower().strip() for t in raw_tags if t.strip())
        
        node_links = {} # target_id -> list of shared tags
        
        for tag in tags:
            if tag in last_seen_tag:
                target_id = last_seen_tag[tag]
                if target_id not in node_links:
                    node_links[target_id] = []
                node_links[target_id].append(tag)
                
            # Update the last seen node for this tag
            last_seen_tag[tag] = node_id
            
        for target_id, shared_tags in node_links.items():
            details = f"Shared Context: {len(shared_tags)} tag{'s' if len(shared_tags) != 1 else ''}"
            # note: source_id is the newer node (node_id), target_id is the older node
            links_to_add.add((node_id, target_id, 'contextual', details))
            
    # Insert new contextual links
    for source, target, ltype, details in links_to_add:
        cursor.execute(
            '''INSERT INTO drift_links (source_id, target_id, link_type, details)
               VALUES (?, ?, ?, ?)''',
            (source, target, ltype, details)
        )
        
    conn.commit()
    print(f"Inserted {len(links_to_add)} new chronologically-reduced contextual links.")
    
    # Check #exams coverage specifically
    nodes_with_exams = cursor.execute('''
        SELECT id FROM drift_nodes WHERE context_tags LIKE '%exams%'
    ''').fetchall()
    print(f"Found {len(nodes_with_exams)} nodes with 'exams' tag.")
    
    conn.close()

if __name__ == '__main__':
    fix_contextual_links()
