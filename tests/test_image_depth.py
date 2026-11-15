import time

import mistune
from mistune import InlineParser


def _inputs():
    core = "![" * 1000 + "a" + "](u)" * 1000
    return [core, "[" + core + "](u)"]


def test_deep_images_finish_quickly_html_and_ast():
    for renderer in (None, "ast"):
        md = mistune.create_markdown(renderer=renderer)
        for src in _inputs():
            start = time.time()
            md(src)
            assert time.time() - start < 5


def test_image_depth_setting():
    assert InlineParser().max_image_depth == 6
    assert mistune.create_markdown().inline.max_image_depth == 6
    md = mistune.Markdown(inline=InlineParser(max_image_depth=2))
    assert md.inline.max_image_depth == 2


def test_image_depth_limit_applies():
    md = mistune.create_markdown(renderer="ast")
    md.inline.max_image_depth = 2
    tokens = md("![![![a](u)](u)](u)")[0]["children"]
    depth = 0
    node = tokens[0]
    while node["type"] == "image":
        depth += 1
        node = node["children"][0]
    assert depth == 2
