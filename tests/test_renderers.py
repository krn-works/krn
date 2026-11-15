from unittest import TestCase

from mistune import BlockState, HTMLRenderer, create_markdown
from mistune.renderers.rst import RSTRenderer
from mistune.renderers.markdown import MarkdownRenderer
from tests import BaseTestCase


def load_renderer(renderer):
    class TestRenderer(BaseTestCase):
        parse = create_markdown(renderer=renderer)

    name = renderer.NAME
    TestRenderer.load_fixtures("renderer_" + name + ".txt")
    globals()["TestRenderer" + name.title()] = TestRenderer


load_renderer(RSTRenderer())
load_renderer(MarkdownRenderer())


class TestMarkdownRendererRoundTrip(TestCase):
    """Reformatting valid Markdown must not change its meaning: rendering the
    reformatted source to HTML must match rendering the original source."""

    to_html = create_markdown(escape=False)
    reformat = create_markdown(renderer=MarkdownRenderer())

    def assert_round_trip(self, text):
        self.assertEqual(
            self.to_html(self.reformat(text)),
            self.to_html(text),
        )

    def test_escaped_block_markers(self):
        # an escaped leading marker is literal text, not a new block
        for marker in (r"\*", r"\-", r"\+", r"\#", r"\##", r"\>", r"1\.", r"3\)"):
            self.assert_round_trip(marker + " literal\n")

    def test_escaped_marker_on_continuation_line(self):
        self.assert_round_trip("paragraph\n\\* not a list\n")

    def test_escaped_marker_inside_list_item(self):
        self.assert_round_trip("- item\n\n  \\# not a heading\n")

    def test_escaped_backtick(self):
        self.assert_round_trip(r"\`not code\`" + "\n")

    def test_real_markers_preserved(self):
        for text in (
            "* bullet\n",
            "# heading\n",
            "1. ordered\n",
            "> quote\n",
            "`code`\n",
            "*emphasis*\n",
        ):
            self.assert_round_trip(text)

    def test_prose_not_over_escaped(self):
        for text in (
            "snake_case_var\n",
            "use - dashes - here\n",
            "C# and a.b.c and 1.5\n",
            "ratio a/b is fine\n",
        ):
            self.assert_round_trip(text)


class TestRendererMethodRegistration(TestCase):
    def test_registered_renderer_method(self):
        renderer = HTMLRenderer(escape=False)

        def render_wiki(renderer, key, title):
            return f'<a href="/wiki/{key}">{title}</a>'

        renderer.register("wiki", render_wiki)
        token = {"type": "wiki", "raw": "python", "attrs": {"title": "Python"}}

        self.assertEqual(
            renderer.render_token(token, BlockState()),
            '<a href="/wiki/python">Python</a>',
        )


def test_markdown_task_list_item():
    from mistune import create_markdown
    from mistune.renderers.markdown import MarkdownRenderer

    md = create_markdown(renderer=MarkdownRenderer(), plugins=["task_lists"])
    assert md("- [x] a task") == "- [x] a task\n"
    assert md("- [ ] todo") == "- [ ] todo\n"


def test_markdown_task_list_item_override():
    from mistune import create_markdown
    from mistune.renderers.markdown import MarkdownRenderer

    class R(MarkdownRenderer):
        def task_list_item(self, token, state):
            return "- TASK\n"

    md = create_markdown(renderer=R(), plugins=["task_lists"])
    assert md("- [x] a task") == "- TASK\n"


def test_markdown_table():
    from mistune import create_markdown
    from mistune.renderers.markdown import MarkdownRenderer

    md = create_markdown(renderer=MarkdownRenderer(), plugins=["table"])
    assert md("| A | B |\n|---|---|\n| 1 | 2 |\n") == "| A | B |\n| --- | --- |\n| 1 | 2 |\n"
    assert md("| A | B |\n|:--|--:|\n| 1 | 2 |\n") == "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n"


def test_standalone_list_item_token():
    from mistune.core import BlockState
    from mistune.renderers.markdown import MarkdownRenderer

    token = {"type": "list_item", "children": [{"type": "paragraph", "children": [{"type": "text", "raw": "x"}]}]}
    assert MarkdownRenderer().render_token(token, BlockState()) == "- x\n\n"


def test_rst_list_item_and_table():
    from mistune import create_markdown
    from mistune.core import BlockState
    from mistune.renderers.rst import RSTRenderer

    md = create_markdown(renderer=RSTRenderer(), plugins=["table", "task_lists"])
    assert md("| A | B |\n|---|---|\n| 1 | 2 |\n") == (
        "+---+---+\n| A | B |\n+===+===+\n| 1 | 2 |\n+---+---+\n"
    )
    assert md("- [x] a task") == "- [x] a task\n"
    token = {"type": "list_item", "children": [{"type": "paragraph", "children": [{"type": "text", "raw": "x"}]}]}
    assert RSTRenderer().render_token(token, BlockState()) == "- x\n\n"
