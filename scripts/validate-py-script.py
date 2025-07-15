from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence

# ────────────────────────────────────────────────────────────────────────────
# 💡  CONFIGURATION  – adjust to taste
# ────────────────────────────────────────────────────────────────────────────
ROOT_DIR: Path = Path("./input")

SKIP_DEFS: Sequence[str] = [
    "CodeSystem: medcom-test",
    "Profile: tester",
    "ValueSet: NextUp",
]

WHITELIST: Sequence[str] = ["MedCom"]

# ────────────────────────────────────────────────────────────────────────────
# Data model
# ────────────────────────────────────────────────────────────────────────────
@dataclass(slots=True, frozen=True)
class Definition:
    kind: str       # "Profile" | "CodeSystem" | "ValueSet"
    name: str       # PascalCase definition name
    id_: str        # Id: value (may be empty)
    file: Path
    line_no: int    # 1‑based definition line number


# ────────────────────────────────────────────────────────────────────────────
# Helpers – casing
# ────────────────────────────────────────────────────────────────────────────
_pascal_re = re.compile(r"^[A-Z][A-Za-z0-9]*$")


def is_pascal_case(word: str) -> bool:
    return bool(_pascal_re.fullmatch(word))


def kebab_from_pascal(pascal: str, whitelist: Sequence[str]) -> str:
    """Convert PascalCase → kebab‑case, keeping whitelist tokens intact."""
    wl_set = set(whitelist)
    segments: List[str] = []
    i = 0
    while i < len(pascal):
        hit = next((w for w in wl_set if pascal.startswith(w, i)), None)
        if hit:
            segments.append(hit.lower())
            i += len(hit)
            continue

        start = i
        i += 1
        while i < len(pascal) and (pascal[i].islower() or pascal[i].isdigit()):
            i += 1
        segments.append(pascal[start:i].lower())

    return "-".join(segments)


# ────────────────────────────────────────────────────────────────────────────
# FSH parsing
# ────────────────────────────────────────────────────────────────────────────
_definition_start = re.compile(r"^\s*(Profile|CodeSystem|ValueSet):\s+(\S+)")
_id_line = re.compile(r"^\s*Id:\s+(\S+)")


def load_definitions(path: Path) -> Iterable[Definition]:
    with path.open(encoding="utf-8", errors="ignore") as fh:
        lines = fh.readlines()

    i = 0
    while i < len(lines):
        m = _definition_start.match(lines[i])
        if not m:
            i += 1
            continue

        kind, name = m.group(1), m.group(2)
        id_value = ""
        j = i + 1
        while j < len(lines) and not _definition_start.match(lines[j]):
            id_match = _id_line.match(lines[j])
            if id_match:
                id_value = id_match.group(1)
            j += 1
        yield Definition(kind, name, id_value, path, i + 1)
        i = j


# ────────────────────────────────────────────────────────────────────────────
# Validation
# ────────────────────────────────────────────────────────────────────────────
def validate(
    definitions: Iterable[Definition],
    whitelist: Sequence[str],
    skip: Sequence[str],
) -> List[str]:
    skip_set = {s.lower() for s in skip}
    errors: List[str] = []

    for d in definitions:
        if f"{d.kind.lower()}: {d.name.lower()}" in skip_set:
            continue

        if not is_pascal_case(d.name):
            errors.append(
                f"{d.file}:{d.line_no}: {d.kind} '{d.name}' is not PascalCase"
            )

        if d.id_:
            expected = kebab_from_pascal(d.name, whitelist)
            if d.id_ != expected:
                errors.append(
                    f"{d.file}:{d.line_no}: Id '{d.id_}' "
                    f"≠ expected '{expected}' for {d.name}"
                )
    return errors


# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────
def main() -> None:
    if not ROOT_DIR.is_dir():
        sys.exit(f"Directory not found: {ROOT_DIR}")

    fsh_files = list(ROOT_DIR.rglob("*.fsh"))
    if not fsh_files:
        print("No .fsh files found – nothing to do.")
        return

    all_defs: List[Definition] = []
    for fpath in fsh_files:
        all_defs.extend(load_definitions(fpath))

    problems = validate(all_defs, WHITELIST, SKIP_DEFS)

    if problems:
        print("\n".join(problems))
        print(f"\n❌ Validation failed ({len(problems)} problem(s)).")
        sys.exit(1)

    print(f"✅ All checks passed ({len(all_defs)} definitions scanned).")


if __name__ == "__main__":
    main()
