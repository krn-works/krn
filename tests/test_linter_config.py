import pathlib
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_pyproject_configures_ruff():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert "ruff" in data["tool"]
