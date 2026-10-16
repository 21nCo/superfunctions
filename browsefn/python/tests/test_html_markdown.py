from browsefn.utils.html_utils import html_to_markdown


def test_markdown_preserves_document_order_and_structure():
    result = html_to_markdown('<p>first <a href="/next">Next</a></p><h2>Second</h2><ul><li>list item</li></ul><pre><code>const a = 1;</code></pre>')
    assert result.index('first') < result.index('## Second')
    assert '[Next](/next)' in result
    assert '* list item' in result
    assert '    const a = 1;' in result
