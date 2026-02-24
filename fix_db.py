import sqlite3

def remove_check_constraint():
    conn = sqlite3.connect('drift_v2.db')
    cursor = conn.cursor()
    
    print("Reading old schema...")
    # Get the original create statement
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='drift_links'")
    sql = cursor.fetchone()[0]
    print("Old schema:\n", sql)
    
    # We will recreate the table
    cursor.execute("PRAGMA foreign_keys=off")
    cursor.execute("BEGIN TRANSACTION")
    
    cursor.execute("ALTER TABLE drift_links RENAME TO drift_links_old")
    
    # Create the new table without any link_type CHECK constraints
    cursor.execute("""
        CREATE TABLE drift_links (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            target_id INTEGER NOT NULL,
            link_type TEXT    NOT NULL,
            details   TEXT,
            verified  INTEGER DEFAULT 0,
            FOREIGN KEY (source_id) REFERENCES drift_nodes(id),
            FOREIGN KEY (target_id) REFERENCES drift_nodes(id)
        )
    """)
    
    print("Copying data...")
    cursor.execute("INSERT INTO drift_links SELECT * FROM drift_links_old")
    
    cursor.execute("DROP TABLE drift_links_old")
    
    conn.commit()
    cursor.execute("PRAGMA foreign_keys=on")
    conn.close()
    print("Done recreating drift_links.")

if __name__ == "__main__":
    remove_check_constraint()
