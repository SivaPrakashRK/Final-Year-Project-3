import os
os.environ["HF_HOME"] = r"D:\huggingface"

from transformers import pipeline
print("Testing pipeline load...")
p = pipeline("zero-shot-classification", model="facebook/bart-large-mnli")
print("Models working!")
