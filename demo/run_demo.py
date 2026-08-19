"""
Quick runnable demo — no Laravel, no database, no Azure.

Drop two or more images into demo/sample_images/ (e.g. two photos of the
same water bottle from different angles, plus a couple of decoy items),
then run this script while app/server.py is running in another terminal.

Usage:
    # Terminal 1
    uvicorn app.server:app --reload --port 8001

    # Terminal 2
    python demo/run_demo.py --target sample_images/bottle_lost.jpg \\
        --candidates sample_images/bottle_found.jpg sample_images/mug_found.jpg
"""
import argparse
import json
import os
import requests

SERVER = "http://127.0.0.1:8001"


def run_visual_match(target_path, candidate_paths):
    here = os.path.dirname(os.path.abspath(__file__))
    target_abs = os.path.join(here, target_path)

    batch = [
        {"id": i, "image_path": os.path.join(here, c)}
        for i, c in enumerate(candidate_paths)
    ]
    batch_json_path = os.path.join(here, "_batch.json")
    with open(batch_json_path, "w") as f:
        json.dump(batch, f)

    resp = requests.post(f"{SERVER}/match", json={
        "target_img": target_abs,
        "batch_json": batch_json_path,
    })
    os.remove(batch_json_path)

    print("\n=== Visual match results ===")
    print(json.dumps(resp.json(), indent=2))


def run_health_check():
    resp = requests.get(f"{SERVER}/health")
    print("=== Server health ===")
    print(json.dumps(resp.json(), indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", help="Path to the reference (lost) item photo, relative to demo/")
    parser.add_argument("--candidates", nargs="+", help="Paths to candidate (found) item photos, relative to demo/")
    args = parser.parse_args()

    run_health_check()

    if args.target and args.candidates:
        run_visual_match(args.target, args.candidates)
    else:
        print("\nNo --target/--candidates given — just ran the health check.")
        print("Drop some images into demo/sample_images/ and pass paths to try a real match, e.g.:")
        print("  python demo/run_demo.py --target sample_images/a.jpg --candidates sample_images/b.jpg sample_images/c.jpg")
