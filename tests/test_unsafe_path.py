import types

import pytest

import unzip_http

BAD = ['../x', '/tmp/x', 'sub/../../x']


@pytest.mark.parametrize('name', BAD)
def test_extract_rejects_escaping_member(tmp_path, name):
    target = tmp_path / 'target'
    target.mkdir()
    rzf = object.__new__(unzip_http.RemoteZipFile)
    with pytest.raises(Exception, match='unsafe path'):
        rzf.extract(name, target)
    assert list(tmp_path.rglob('x')) == []


@pytest.mark.parametrize('name', BAD)
def test_cli_full_filepaths_rejects_escaping_member(tmp_path, monkeypatch, name):
    work = tmp_path / 'work'
    work.mkdir()
    monkeypatch.chdir(work)
    args = types.SimpleNamespace(files=['*'], stdout=False, full_filepaths=True)
    f = types.SimpleNamespace(filename=name)
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(f, None, args)
    assert list(tmp_path.rglob('x')) == []


def test_extract_inside_target_works(tmp_path):
    class Fake(unzip_http.RemoteZipFile):
        def __init__(self): pass
        def open(self, fn):
            import io
            return io.BytesIO(b'data')
    Fake().extract('sub/ok.txt', tmp_path)
    assert (tmp_path / 'sub' / 'ok.txt').read_bytes() == b'data'
