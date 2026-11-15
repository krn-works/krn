import pathlib
import re


def test_readme_states_test_command():
    text = (pathlib.Path(__file__).parent.parent / "README.md").read_text()
    assert re.search(r"pytest", text)
