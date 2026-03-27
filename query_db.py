import sqlite3
import json

conn = sqlite3.connect("drift_v2.db")
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

with open("query_out.txt", "w") as f:
    f.write("Nodes:\n")
    cursor.execute("SELECT * FROM drift_nodes ORDER BY timestamp DESC LIMIT 3;")
    nodes = cursor.fetchall()
    for n in nodes:
        d = dict(n)
        f.write(str(d) + "\n")

    f.write("\nLinks:\n")
    cursor.execute("SELECT * FROM drift_links ORDER BY timestamp DESC;")
    links = cursor.fetchall()
    for l in links:
        d = dict(l)
        f.write(str(d) + "\n")

conn.close()
