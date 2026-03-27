import sqlite3
import os

DB_FILE = "drift_v2.db"

def delete_all_entries():
    if not os.path.exists(DB_FILE):
        print(f"Database {DB_FILE} not found!")
        return

    print("Connecting to database...")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Get all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()

    print("Entries before deletion:")
    for table_name in tables:
        table = table_name[0]
        cursor.execute(f"SELECT COUNT(*) FROM '{table}'")
        count = cursor.fetchone()[0]
        print(f"  {table}: {count} rows")

    print("\nDeleting entries...")
    for table_name in tables:
        table = table_name[0]
        if table != "sqlite_sequence": # Keep autoincrement sequence table if present
            try:
                cursor.execute(f"DELETE FROM '{table}';")
                print(f"  Deleted all entries from {table}.")
            except Exception as e:
                print(f"  Error deleting from {table}: {e}")
                
    conn.commit()

    print("\nEntries after deletion:")
    for table_name in tables:
        table = table_name[0]
        cursor.execute(f"SELECT COUNT(*) FROM '{table}'")
        count = cursor.fetchone()[0]
        print(f"  {table}: {count} rows")

    conn.close()
    print("\nCleanup complete.")

if __name__ == "__main__":
    delete_all_entries()
