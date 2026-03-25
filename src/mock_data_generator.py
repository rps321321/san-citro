"""Generate mock JSONL.ZST test data for the Anna's Archive toolkit."""
import json
from typing import List, Dict
import zstandard as zstd

MOCK_RECORDS: List[Dict[str, str]] = [
    {
        "md5": "72a7e9cb2b7a5c9d03f6ae095745a1fa",
        "title": "The Great Gatsby",
        "author": "F. Scott Fitzgerald",
        "year": "1925",
        "extension": "epub",
        "language": "en",
    },
    {
        "md5": "fe466a18aad3b80e48317b056ef0c7dc",
        "title": "1984",
        "author": "George Orwell",
        "year": "1949",
        "extension": "epub",
        "language": "en",
    },
    {
        "md5": "a221184609976c4fda562fa21c6d9315",
        "title": "Pride and Prejudice",
        "author": "Jane Austen",
        "year": "1813",
        "extension": "epub",
        "language": "en",
    },
    {
        "md5": "f8e1b8738bc552abe59a5b99e316b19b",
        "title": "Moby Dick",
        "author": "Herman Melville",
        "year": "1851",
        "extension": "epub",
        "language": "en",
    },
    {
        "md5": "fc84a48afddd633aa4140b32ee20a58b",
        "title": "Alice in Wonderland",
        "author": "Lewis Carroll",
        "year": "1865",
        "extension": "epub",
        "language": "en",
    },
]


def create_mock_data(filename: str) -> None:
    """Create a compressed JSONL file with mock book records."""
    cctx = zstd.ZstdCompressor()
    with open(filename, "wb") as f:
        with cctx.stream_writer(f) as compressor:
            for record in MOCK_RECORDS:
                line = json.dumps(record) + "\n"
                compressor.write(line.encode("utf-8"))


if __name__ == "__main__":
    create_mock_data("classics.jsonl.zst")
    print("Classics mock metadata dump created: classics.jsonl.zst")
