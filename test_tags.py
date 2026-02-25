import sqlite3, requests, json

print('\n=== STEP 1: DB State before new save ===')
conn = sqlite3.connect('drift_v2.db')
cur = conn.cursor()
cur.execute('SELECT id, context_tags FROM drift_nodes ORDER BY id DESC LIMIT 20')
rows = cur.fetchall()
print('Rows:', rows)
conn.close()

payload1 = {
    'user_id': 1, 'entry_type': 'free_form', 'situation': 'S1',
    'automatic_thought': 'Entry 1', 'context_tags': ['work', 'stress'],
    'approved_links': []
}
print('\n=== STEP 2: Frontend Payload Saving Node 1 ===')
# The frontend uses JS JSON.stringify which omits spaces: '["work","stress"]'
print('Sending tags format via JSON:', json.dumps(payload1['context_tags'], separators=(',', ':')))
res = requests.post('http://localhost:8001/save_thought', json=payload1)
print('Save status:', res.status_code)

print('\n=== STEP 1b: DB State after save ===')
conn = sqlite3.connect('drift_v2.db')
cur = conn.cursor()
cur.execute('SELECT id, context_tags FROM drift_nodes ORDER BY id DESC LIMIT 5')
print('Rows:', cur.fetchall())
conn.close()

payload2 = {
    'user_id': 1, 'entry_type': 'free_form', 'situation': 'S2',
    'automatic_thought': 'Entry 2', 'context_tags': ['work', 'family']
}
print('\n=== STEP 3: Analyzing Node 2 (shares work) ===')
res2 = requests.post('http://localhost:8001/analyze_thought', json=payload2)
if res2.status_code == 200:
    print('proposed_links.contextual:', json.dumps(res2.json().get('proposed_links', {}).get('contextual', []), indent=2))
else:
    print('Analyze Error:', res2.status_code, res2.text)
