"""Sphinx extension: every video embed sphinxcontrib-youtube renders is
loading="lazy", so a page does not fetch a player for a video nobody has
played. Listed after sphinxcontrib.youtube in conf; overrides its HTML
visitors and touches nothing else."""

from sphinxcontrib.youtube import peertube, utils, vimeo, youtube


def _lazy(visit):
    def visit_lazy(self, node):
        visit(self, node)
        # The visitor appended the wrapper div, the iframe tag, then the close.
        for i in range(len(self.body) - 1, -1, -1):
            tag = self.body[i]
            if tag.startswith("<iframe"):
                if "loading=" not in tag:
                    self.body[i] = tag.replace("<iframe", '<iframe loading="lazy"', 1)
                break
    return visit_lazy


def setup(app):
    for node_class, visitors in (
        (youtube.youtube, youtube._NODE_VISITORS),
        (vimeo.vimeo, utils._NODE_VISITORS),
        (peertube.peertube, peertube._NODE_VISITORS),
    ):
        visitors = dict(visitors)
        visit, depart = visitors["html"]
        visitors["html"] = (_lazy(visit), depart)
        app.add_node(node_class, override=True, **visitors)
    return {"parallel_read_safe": True, "parallel_write_safe": True}
