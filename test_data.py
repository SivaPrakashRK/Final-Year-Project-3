import requests
import json
from datetime import datetime, timedelta, timezone
import time
import random

BASE_URL = "http://localhost:8000"

def log_entry(endpoint, payload):
    url = f"{BASE_URL}{endpoint}"
    print(f"POSTing to {endpoint} | Date: {payload.get('timestamp')} | Thought: {payload.get('automatic_thought')[:40]}...")
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        data = response.json()
        print(f"  -> SUCCESS: Node ID {data.get('node_id')}, Rumination Guard: {data.get('rumination_detected')}")
    except Exception as e:
        print(f"  -> ERROR: {e}")
        if hasattr(e, 'response') and e.response:
            print(f"     Details: {e.response.text}")
    time.sleep(1) # Let the backend process embeddings smoothly without hammering SQLite locks

# Anchor date: today.
now = datetime.now(timezone.utc)

def days_ago(d, h=12, m=0):
    dt = now - timedelta(days=d)
    return dt.replace(hour=h, minute=m, second=0, microsecond=0).isoformat()

# ── 50 Test Entries spanning 4 weeks ───────────────────────────────────────
entries = [
    # ── WEEK 4 (Oldest) ── 
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(28, 10), "situation": "Manager gave me difficult feedback.", "automatic_thought": "I am terrible at this job and going to be fired.", "context_tags": ["work", "career"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(27, 14), "situation": "Code review was rejected.", "automatic_thought": "My code is always broken, I am not cut out to be an engineer.", "context_tags": ["work", "coding"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(26, 9), "situation": "Morning standup meeting.", "automatic_thought": "Everyone else sounds so smart, I have nothing good to report.", "context_tags": ["work", "social"]
    }},
    {"type": "/log_evidence_reframe_diary", "payload": {
        "timestamp": days_ago(25, 18), "situation": "End of a tough week at work.", "automatic_thought": "I will never succeed in this industry.", "thought_belief_before": 80, 
        "emotion": "hopeless", "emotion_intensity": 75,
        "evidence_for": "I got negative feedback on my recent sprint.", "evidence_against": "I have successfully delivered 3 previous projects this year.",
        "reframed_thought": "I struggled this week, but it is one isolated incident and I can improve.", "thought_belief_after": 30, "context_tags": ["work", "reflection"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(24, 11), "situation": "Weekend hike with friends.", "automatic_thought": "It's so nice to disconnect and just enjoy nature.", "context_tags": ["weekend", "friends", "outdoors"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(23, 10), "situation": "Woke up early and read a book.", "automatic_thought": "I feel really rested and calm today.", "context_tags": ["weekend", "relaxation"]
    }},

    # ── Compensatory Whiplash (Week 3) ──
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(21, 9), "situation": "Preparing for a big presentation.", "automatic_thought": "I am entirely unprepared, I am going to bomb this so badly.", "context_tags": ["work", "presentation"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(20, 15), "situation": "Finished the big presentation.", "automatic_thought": "I absolutely crushed it! I am the best employee in the entire department! I am unstoppable!", "context_tags": ["work", "presentation"]
    }},
    
    # ── Rumination Loop (Semantic similarity >= 0.85 within 24h) ──
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(19, 10, 0), "situation": "Waiting for a text back from a friend.", "automatic_thought": "They hate me. They are ignoring me on purpose because I'm annoying.", "context_tags": ["friends", "anxiety"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(19, 13, 30), "situation": "Still no reply to my message.", "automatic_thought": "My friends secretly dislike me and find me completely annoying.", "context_tags": ["friends", "anxiety"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(19, 17, 15), "situation": "Saw they were online but didn't reply.", "automatic_thought": "Nobody likes me. My friends find me annoying and don't want to talk to me.", "context_tags": ["friends", "anxiety", "isolation"]
    }},
    
    # ── Various other scattered thoughts (Week 3) ──
    {"type": "/log_evidence_reframe_diary", "payload": {
        "timestamp": days_ago(18, 20), "situation": "Friend finally replied and apologised they were busy.", "automatic_thought": "They are just lying to be polite.", "thought_belief_before": 60,
        "emotion": "anxious", "emotion_intensity": 70,
        "evidence_for": "They took hours to reply.", "evidence_against": "They specifically said they had a family emergency.",
        "reframed_thought": "They were dealing with their own life stress, it has nothing to do with me.", "thought_belief_after": 10, "context_tags": ["friends", "reflection"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(17, 12), "situation": "Tried to cook a new recipe.", "automatic_thought": "I burned the toast. I ruin everything I try.", "context_tags": ["cooking", "home"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(16, 14), "situation": "Went for a run.", "automatic_thought": "I feel sluggish but I'm glad I got outside.", "context_tags": ["health", "exercise"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(15, 8), "situation": "Watching the sunrise.", "automatic_thought": "The sky is very beautiful today.", "context_tags": ["morning", "nature"]
    }},

    # ── WEEK 2 ──
    # Context clustering
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(14, 10, 15), "situation": "Studying for certification exam.", "automatic_thought": "There is way too much material here.", "context_tags": ["study", "exam"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(14, 10, 50), "situation": "Trying to memorize chapter 3.", "automatic_thought": "I can't retain any of this information.", "context_tags": ["study", "exam"]
    }},
    {"type": "/log_evidence_reframe_diary", "payload": {
        "timestamp": days_ago(13, 11), "situation": "Feeling overwhelmed by the exam syllabus.", "automatic_thought": "I am guaranteed to fail.", "thought_belief_before": 90,
        "emotion": "overwhelmed", "emotion_intensity": 85,
        "evidence_for": "There are 400 pages left.", "evidence_against": "I passed my last exam by breaking it into chunks.",
        "reframed_thought": "I can focus on one chapter per day and pass.", "thought_belief_after": 40, "context_tags": ["study", "exam", "planning"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(12, 18), "situation": "Played a video game to relax.", "automatic_thought": "That was a fun match with friends.", "context_tags": ["gaming", "relaxation"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(11, 20), "situation": "Watching a movie.", "automatic_thought": "The plot was a bit confusing but visually stunning.", "context_tags": ["media", "movie"]
    }},
    # More negative drift
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(10, 9), "situation": "Lost my keys before leaving the house.", "automatic_thought": "I am always so stupid and disorganised.", "context_tags": ["morning", "rushing"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(9, 14), "situation": "Forgot to send an email.", "automatic_thought": "My boss will definitely fire me for this.", "context_tags": ["work", "mistake"]
    }},
    {"type": "/log_evidence_reframe_diary", "payload": {
        "timestamp": days_ago(8, 16), "situation": "Worrying about the forgotten email.", "automatic_thought": "This email mistake will ruin my whole career.", "thought_belief_before": 70,
        "emotion": "fear", "emotion_intensity": 60,
        "evidence_for": "It was for a client.", "evidence_against": "My boss just said 'no worries, send it now'.",
        "reframed_thought": "It was a small slip up that got fixed quickly.", "thought_belief_after": 5, "context_tags": ["work", "reflection"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(7, 22), "situation": "Lying in bed.", "automatic_thought": "I feel calm and ready for sleep.", "context_tags": ["sleep", "night"]
    }},

    # ── WEEK 1 (Most Recent) ── 
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(6, 9), "situation": "Morning coffee.", "automatic_thought": "Today is going to be a good day.", "context_tags": ["morning", "coffee"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(5, 12), "situation": "Lunch break walk.", "automatic_thought": "The weather is really pleasant.", "context_tags": ["outdoors", "walk"]
    }},
    # Another compensatory link trigger
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(4, 10), "situation": "Project deadline approach.", "automatic_thought": "This project is a complete disaster, we are totally doomed.", "context_tags": ["work", "project"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(3, 16), "situation": "Project delivered.", "automatic_thought": "This is the greatest project our company has ever made, I am a genius.", "context_tags": ["work", "project"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(2, 11), "situation": "Team meeting.", "automatic_thought": "I enjoy working with this team.", "context_tags": ["work", "team"]
    }},
    {"type": "/log_evidence_reframe_diary", "payload": {
        "timestamp": days_ago(1, 14), "situation": "Criticism from a colleague.", "automatic_thought": "They think I am incompetent.", "thought_belief_before": 60,
        "emotion": "defensive", "emotion_intensity": 75,
        "evidence_for": "They pointed out a bug in my code.", "evidence_against": "They said the rest of the feature was excellent.",
        "reframed_thought": "They gave me constructive feedback on one bug, while praising the overall work.", "thought_belief_after": 15, "context_tags": ["work", "feedback"]
    }},
    {"type": "/log_thought", "payload": {
        "timestamp": days_ago(0, 9), "situation": "Starting the day.", "automatic_thought": "I feel focused and ready.", "context_tags": ["morning", "focus"]
    }}
]

# Generate padding entries to hit 50 exactly. Just neutral freeform thoughts.
topics = [("Ate a nice sandwich", "Lunch was tasty.", ["food", "lunch"]), 
          ("Read the news", "World events are stressful.", ["news"]), 
          ("Cleaned the kitchen", "The house looks much better now.", ["chores", "home"]),
          ("Listened to a podcast", "Learned something new about history.", ["learning", "podcast"]),
          ("Stretching", "My back feels less stiff.", ["health", "stretching"])]

for i in range(50 - len(entries)):
    topic = random.choice(topics)
    # Spread them across the last 28 days randomly
    d = random.randint(1, 28)
    h = random.randint(8, 20)
    entries.append({"type": "/log_thought", "payload": {
        "timestamp": days_ago(d, h), "situation": topic[0], "automatic_thought": topic[1], "context_tags": topic[2]
    }})

# Sort chronologically so FAISS handles the timeline appropriately
entries.sort(key=lambda x: x["payload"]["timestamp"])

print(f"Loaded {len(entries)} entries to inject.")

for e in entries:
    log_entry(e["type"], e["payload"])

print("All entries posted! Run your index.html and view the graphs.")
