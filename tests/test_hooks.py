from unittest import TestCase

from mistune import create_markdown
from mistune.toc import add_toc_hook, render_toc_ul
from tests import BaseTestCase


class TestTocHook(BaseTestCase):
    @staticmethod
    def parse(text):
        md = create_markdown(escape=False)
        add_toc_hook(md)
        html, state = md.parse(text)
        result = html + render_toc_ul(state.env["toc_items"])
        return result

    def test_customize_heading_id_func(self):
        def heading_id(token, i):
            return "t-" + str(i + 1)

        md = create_markdown(escape=False)
        add_toc_hook(md, heading_id=heading_id)
        html = md("# h1")
        self.assertEqual(html, '<h1 id="t-1">h1</h1>\n')

    def test_render_empty_toc(self):
        self.assertEqual(render_toc_ul([]), "")
        self.assertEqual(render_toc_ul(filter(lambda _: False, [])), "")


TestTocHook.load_fixtures("hook_toc.txt")


class TestTocExistingIds(TestCase):
    @staticmethod
    def _keep_id(token, state):
        if token["type"] == "heading":
            token["attrs"]["id"] = "existing"

    def _md(self, directive):
        import mistune
        from mistune.directives import FencedDirective, TableOfContents

        if directive:
            md = mistune.create_markdown(escape=False, plugins=[FencedDirective([TableOfContents()])])
        else:
            md = mistune.create_markdown(escape=False)
            add_toc_hook(md)

        def hook(md_, state):
            for t in state.tokens:
                self._keep_id(t, state)

        md.before_render_hooks.insert(0, hook)
        return md

    def test_collision_with_html_ids(self):
        import mistune
        from mistune.directives import FencedDirective, TableOfContents

        md = mistune.create_markdown(escape=False, plugins=[FencedDirective([TableOfContents()])])
        html = md('<div id="toc_1"></div>\n\n<div id="toc_1_1"></div>\n\n# title\n\n```{toc}\n```\n')
        self.assertIn('<h1 id="toc_1_2">title</h1>', html)
        self.assertIn('href="#toc_1_2"', html)

    def test_directive_keeps_existing_id(self):
        html = self._md(True)("# title\n\n```{toc}\n```\n")
        self.assertIn('<h1 id="existing">title</h1>', html)
        self.assertIn('href="#existing"', html)
        self.assertNotIn("toc_1", html)

    def test_hook_keeps_existing_id(self):
        md = self._md(False)
        html, state = md.parse("# title\n")
        self.assertIn('<h1 id="existing">', html)
        self.assertEqual(state.env["toc_items"][0][1], "existing")

    def test_two_sections_share_ids(self):
        import mistune
        from mistune.directives import FencedDirective, TableOfContents

        md = mistune.create_markdown(escape=False, plugins=[FencedDirective([TableOfContents()])])
        html = md("```{toc}\n```\n\n# a\n\n```{toc}\n```\n")
        self.assertEqual(html.count('href="#toc_1"'), 2)
        self.assertEqual(html.count('id="toc_1"'), 1)
