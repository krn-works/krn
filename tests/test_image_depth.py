import time

import mistune
from mistune.inline_parser import InlineParser

DEEP = "![" * 1000 + "a" + "](u)" * 1000
LINKED = "[" + DEEP + "](u)"


def test_default_and_configurable():
    assert InlineParser().max_image_depth == 20
    assert InlineParser(max_image_depth=3).max_image_depth == 3
    md = mistune.create_markdown()
    md.inline.max_image_depth = 5
    assert md.inline.max_image_depth == 5


def test_deep_images_finish_quickly():
    for text in (DEEP, LINKED):
        for renderer in (None, "ast"):
            start = time.time()
            mistune.create_markdown(renderer=renderer)(text)
            assert time.time() - start < 5


def _depth(tokens):
    best = 0
    for t in tokens:
        if t["type"] == "image":
            best = max(best, 1 + _depth(t.get("children", [])))
        elif "children" in t:
            best = max(best, _depth(t["children"]))
    return best


def test_depth_is_bounded():
    md = mistune.create_markdown(renderer="ast")
    md.inline.max_image_depth = 2
    assert _depth(md("![![![a](u)](u)](u)")) == 2
