import unzip_http


def test_module_imports():
    assert unzip_http.RemoteZipFile


import pytest


def _rzf():
    return object.__new__(unzip_http.RemoteZipFile)


@pytest.mark.parametrize('name', ['../x', '/tmp/x', 'sub/../../x'])
def test_extract_rejects_unsafe_path(tmp_path, name):
    target = tmp_path / 'target'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        _rzf().extract(name, target)
    assert [p for p in tmp_path.rglob('*') if p != target] == []


def test_safe_join_allows_inside(tmp_path):
    assert unzip_http.safe_join(tmp_path, 'a/b.txt') == tmp_path / 'a/b.txt'
    assert unzip_http.safe_join(tmp_path, 'sub/../b') == tmp_path / 'sub/../b'


def test_cli_full_filepaths_rejects_unsafe(tmp_path, monkeypatch):
    import types
    monkeypatch.chdir(tmp_path)
    f = types.SimpleNamespace(filename='../x', compress_size=0)
    args = types.SimpleNamespace(files=['*'], stdout=False, full_filepaths=True)
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(f, None, args)
