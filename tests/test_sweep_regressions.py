import io

from boltons.cacheutils import LRI, LRU, ThresholdCounter
from boltons.jsonutils import reverse_iter_lines
from boltons.strutils import bytes2human
from boltons.urlutils import URL


def test_threshold_counter_mapping_and_keywords():
    tc = ThresholdCounter()
    tc.update({'a': 3, 'b': 2, 'zero': 0})
    assert tc.total == 5
    assert tc['a'] == 3 and tc['b'] == 2 and 'zero' not in tc
    tc.update(['a'], a=3, b=2)
    assert tc['a'] == 7 and tc['b'] == 4 and tc.total == 11


def test_threshold_counter_compaction_matches_one_by_one():
    data = {'a': 30, 'b': 5, 'c': 1, 'd': 2}
    one = ThresholdCounter(threshold=0.1)
    for k, n in data.items():
        for _ in range(n):
            one.add(k)
    many = ThresholdCounter(threshold=0.1)
    many.update(data)
    assert dict(many.items()) == dict(one.items())
    assert many.total == one.total


def test_most_common_zero_and_all():
    tc = ThresholdCounter()
    tc.update('aab')
    assert tc.most_common(0) == []
    assert tc.most_common() == [('a', 2), ('b', 1)]


def test_lru_update_forms():
    for cls in (LRI, LRU):
        c = cls(max_size=5)
        c.update()
        c.update(a=1, b=2)
        assert dict(c) == {'a': 1, 'b': 2}
        c.update(c)
        assert dict(c) == {'a': 1, 'b': 2}
        c.update([('c', 3)], other=4)
        c.update({'d': 5}, E=6)
        assert c['other'] == 4 and c['E'] == 6 and c['c'] == 3


def test_reverse_iter_lines_latin1_text(tmp_path):
    p = tmp_path / 'f.txt'
    p.write_bytes('caf\xe9\nna\xefve\n'.encode('latin-1'))
    with open(p, encoding='latin-1') as f:
        assert list(reverse_iter_lines(f)) == ['', 'na\xefve', 'caf\xe9']
        f.seek(0)
        assert f.read() == 'caf\xe9\nna\xefve\n'


def test_reverse_iter_lines_binary_encoding():
    b = io.BytesIO('caf\xe9\nx'.encode('latin-1'))
    assert list(reverse_iter_lines(b, encoding='latin-1')) == ['x', 'caf\xe9']


def test_reverse_iter_lines_text_stream_stays_usable(tmp_path):
    p = tmp_path / 'f.txt'
    p.write_text('a\nb\n')
    with open(p) as f:
        list(reverse_iter_lines(f))
        f.seek(0)
        assert f.read() == 'a\nb\n'


def test_bytes2human_largest_unit():
    assert bytes2human(1024 ** 8) == '1Y'
    assert bytes2human(1024 ** 9) == '1024Y'


def test_url_password_without_username():
    u = URL('http://:secret@example.com/path')
    assert u.to_text() == 'http://:secret@example.com/path'
    assert u.get_authority(with_userinfo=True) == ':secret@example.com'


def test_url_password_round_trip():
    u = URL('http://example.com/')
    u.password = 'p@ss'
    text = u.to_text()
    assert 'p%40ss' in text
    assert URL(text).password == 'p@ss'
