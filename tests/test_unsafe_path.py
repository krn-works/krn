import io
import pytest
import unzip_http


class FakeZip(unzip_http.RemoteZipFile):
    def __init__(self):
        pass

    def open(self, fn):
        return io.BytesIO(b'data')


@pytest.mark.parametrize('name', ['../x', '/tmp/zipslip-x', 'sub/../../x'])
def test_unsafe_member_rejected(tmp_path, name):
    target = tmp_path/'target'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        FakeZip().extract(name, target)
    assert list(tmp_path.rglob('x')) == []
    assert list(target.rglob('*')) == []


def test_safe_member_extracts(tmp_path):
    FakeZip().extract('sub/a.txt', tmp_path)
    assert (tmp_path/'sub'/'a.txt').read_bytes() == b'data'


def test_cli_full_filepaths_rejects(tmp_path, monkeypatch):
    import types
    monkeypatch.chdir(tmp_path/'..')
    f = types.SimpleNamespace(filename='../../evil')
    args = types.SimpleNamespace(files=['*'], stdout=False, full_filepaths=True)
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(f, FakeZip(), args)
