"""Answers the recall eval set through mem0, and says what came back.

mem0 is a Python library, so the comparison runs across a process boundary: the
driver hands this script the same notes and the same questions the eval uses in
process, and scores the reply with the same function it scores Milo's with.

Two deliberate choices, both to keep the comparison about architecture rather
than about who has the better model:

- `infer=False` stores each note **verbatim**, which is what Milo's `remember`
  does. With mem0's own pipeline on, an LLM rewrites the notes on the way in, and
  then two things have changed at once.
- the embedder is the one the install is configured with, passed in by the
  driver, so both sides read text into vectors with the same model.

`MEM0_*` comes from the environment. Nothing here prints the key.
"""

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path


def redact(text: str) -> str:
    """A key must not reach a log just because a library logged its config."""
    return re.sub(r"sk-[A-Za-z0-9._-]+", "sk-***", text)


def ask(memory, query: str, user: str, top_k: int, latencies: list) -> list[str]:
    started = time.perf_counter()
    result = memory.search(query, top_k=top_k, filters={"user_id": user})
    latencies.append((time.perf_counter() - started) * 1000)

    texts = []
    for row in result.get("results", []) or []:
        text = row.get("memory") or row.get("data")
        if isinstance(text, str) and text:
            texts.append(text)
    return texts


def main() -> int:
    dataset = json.loads(Path(sys.argv[sys.argv.index("--dataset") + 1]).read_text())
    base = os.environ["MEM0_BASE_URL"]
    key = os.environ["MEM0_API_KEY"]
    model = os.environ["MEM0_EMBED_MODEL"]
    top_k = int(os.environ.get("MEM0_TOP_K", "5"))
    # `infer` is the whole difference between this script storing what it is given
    # and mem0 deciding for itself what is worth keeping — the latter costing a
    # language model per phase and rewriting the notes in its own words.
    infer = os.environ.get("MEM0_INFER") == "1"
    llm_model = os.environ.get("MEM0_LLM_MODEL", "openai/gpt-4o-mini")
    user = "eval"

    # mem0 defaults every component to OpenAI, so pointing the base URL at an
    # OpenAI-compatible endpoint is enough — and with `infer=False` the language
    # model is never called, so only the embedder costs anything.
    os.environ["OPENAI_API_KEY"] = key
    os.environ["OPENAI_BASE_URL"] = base
    os.environ["MEM0_TELEMETRY"] = "False"

    from mem0 import Memory

    # A store of its own per run. mem0's default vector store is a persistent
    # local collection, so without this every run adds the notes again on top of
    # the last — five runs in, one note was stored five times and came back as
    # the whole reply. The eval read that as duplication in mem0, and it was this
    # script all along.
    store = os.environ.get("MEM0_STORE_DIR") or tempfile.mkdtemp()

    memory = Memory.from_config(
        {
            "vector_store": {
                "provider": "qdrant",
                "config": {"collection_name": "eval", "path": store},
            },
            "llm": {
                "provider": "openai",
                "config": {"model": llm_model, "api_key": key, "openai_base_url": base},
            },
            "embedder": {
                "provider": "openai",
                "config": {"model": model, "api_key": key, "openai_base_url": base},
            },
        }
    )

    memory.add(
        [{"role": "user", "content": note} for note in dataset["notes"]],
        user_id=user,
        infer=infer,
    )
    # `get_all` caps at twenty by default, which is not a store that lost notes —
    # it is a count that was asked for less than what is there. The cap is lifted
    # so the count is the store's, and the duplicates are counted too: a store
    # holding one note twice returns it twice, and every number scored from that
    # reply stops meaning what it says.
    rows = memory.get_all(filters={"user_id": user}, top_k=1000).get("results", []) or []
    texts = [row.get("memory") or row.get("data") or "" for row in rows]
    stored = len(texts)
    distinct = len(set(texts))

    latencies: list[float] = []
    replies = [ask(memory, query, user, top_k, latencies) for query in dataset["questions"]]
    unanswerable = [len(ask(memory, query, user, top_k, latencies)) for query in dataset["unanswerable"]]
    # The replies themselves, not a verdict: whether the answer came back is for
    # the driver's scorer to decide, with the same code that decides it for Milo.
    # Asked as "did anything come back" this reported 13/13 for every run, because
    # a vector search always returns something.
    reworded = [ask(memory, query, user, top_k, latencies) for query in dataset["reworded"]]

    json.dump(
        {
            "stored": stored,
            "distinct": distinct,
            "replies": replies,
            "unanswerable": unanswerable,
            "reworded": reworded,
            "latencies": latencies,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the reason is the whole output
        print(redact(f"{type(error).__name__}: {error}")[:600], file=sys.stderr)
        sys.exit(1)
