import io
import pytest
import unzip_http


class FakeZip(unzip_http.RemoteZipFile):
    def __init__(self):
        pass

    def open(self, fn):
        return io.BytesIO(b'data')


@pytest.mark.parametrize('name', ['../x', '/tmp/zipslip_x', 'sub/../../x'])
def test_extract_rejects_unsafe_member(tmp_path, name):
    target = tmp_path/'target'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        FakeZip().extract(name, target)
    assert list(tmp_path.rglob('*')) == [target]


def test_extract_inside_target(tmp_path):
    FakeZip().extract('a/b.txt', tmp_path)
    assert (tmp_path/'a'/'b.txt').read_bytes() == b'data'


def test_cli_full_filepaths_rejects_unsafe(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    class A: stdout = False; full_filepaths = True; files = ['*']
    class F: filename = '../x'
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(F, None, A)
