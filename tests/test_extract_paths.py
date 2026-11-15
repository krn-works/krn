import io
import pytest
import unzip_http


class FakeZip(unzip_http.RemoteZipFile):
    def __init__(self):
        pass

    def open(self, member):
        return io.BytesIO(b'data')


@pytest.mark.parametrize('name', ['../x', '/tmp/zipslip_x', 'sub/../../x'])
def test_extract_rejects_unsafe_path(tmp_path, name):
    target = tmp_path / 'out'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        FakeZip().extract(name, target)
    assert list(tmp_path.rglob('x')) == []
    assert list(target.rglob('*')) == []


def test_extract_inside_target(tmp_path):
    FakeZip().extract('a/b.txt', tmp_path)
    assert (tmp_path / 'a' / 'b.txt').read_bytes() == b'data'


def test_cli_full_filepaths_rejects_unsafe(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    f = unzip_http.RemoteZipInfo('../evil', 0, 0, 0, 0, 0)
    args = type('A', (), dict(files=['*'], stdout=False, full_filepaths=True))()
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(f, FakeZip(), args)
