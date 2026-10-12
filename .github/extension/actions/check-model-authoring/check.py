"""Enforce the model-only restriction on the actual workflow checkout."""

import json
import os
from pathlib import Path
import sys

root = Path.cwd().resolve()
model = (root / os.environ["RADIUS_APP_FILE"]).resolve()
if not model.is_relative_to(root):
    sys.exit("Application model path escapes the checkout.")

try:
    source = model.read_text()
    origin = model.with_name("app.origin.json")
    provenance = json.loads(origin.read_text()) if origin.exists() else {}
    if not isinstance(provenance, dict):
        raise ValueError("Origin must be an object")
    if (
        "// Radius authoring: model-only; deployment: unverified." in source
        or "authoring" in provenance
    ):
        sys.exit("Model-only application: deployment is unverified. No deployment is allowed.")
except (OSError, ValueError) as error:
    sys.exit(f"Cannot establish application authoring provenance: {error}")
