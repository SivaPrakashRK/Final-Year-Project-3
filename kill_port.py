import os
import subprocess

def free_port(port):
    result = subprocess.run(f"netstat -ano | findstr :{port}", shell=True, capture_output=True, text=True)
    if result.stdout:
        lines = result.stdout.strip().split('\n')
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 5 and f":{port}" in parts[1]:
                pid = parts[-1]
                if pid != "0":
                    print(f"Killing process {pid} on port {port}")
                    os.system(f"taskkill /PID {pid} /F")

if __name__ == "__main__":
    free_port(8001)
