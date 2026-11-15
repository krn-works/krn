import io
import pytest
import unzip_http


class StubZip(unzip_http.RemoteZipFile):
    def __init__(self):
        pass

    def open(self, fn):
        return io.BytesIO(b'data')


@pytest.mark.parametrize('name', ['../x', 'sub/../../x', '/tmp/unzip_http_evil_x'])
def test_unsafe_member_rejected(tmp_path, name):
    target = tmp_path/'out'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        StubZip().extract(name, target)
    assert list(tmp_path.rglob('x')) == []
    assert list(target.rglob('*')) == []


def test_safe_member_extracted(tmp_path):
    StubZip().extract('a/b.txt', tmp_path)
    assert (tmp_path/'a'/'b.txt').read_bytes() == b'data'


def test_cli_full_filepaths_rejects_escape(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.safe_join('.', '../x')
