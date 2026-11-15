import os
import pytest
import unzip_http


class FakeZip(unzip_http.RemoteZipFile):
    def __init__(self):
        pass

    def open(self, fn):
        import io
        return io.BytesIO(b'data')


@pytest.mark.parametrize('name', ['../x', '/tmp/x', 'sub/../../x'])
def test_extract_rejects_escape(tmp_path, name):
    target = tmp_path/'target'
    target.mkdir()
    with pytest.raises(Exception, match='unsafe path'):
        FakeZip().extract(name, target)
    assert os.listdir(target) == []
    assert not (tmp_path/'x').exists()


def test_extract_inside_target(tmp_path):
    FakeZip().extract('sub/a.txt', tmp_path)
    assert (tmp_path/'sub'/'a.txt').read_bytes() == b'data'


def test_cli_full_filepaths_rejects_escape(tmp_path, monkeypatch):
    import argparse
    monkeypatch.chdir(tmp_path)
    (tmp_path/'t').mkdir()
    monkeypatch.chdir(tmp_path/'t')
    f = unzip_http.RemoteZipInfo('../x')
    args = argparse.Namespace(files=['*'], stdout=False, full_filepaths=True)
    with pytest.raises(Exception, match='unsafe path'):
        unzip_http.download_file(f, FakeZip(), args)
    assert not (tmp_path/'x').exists()
