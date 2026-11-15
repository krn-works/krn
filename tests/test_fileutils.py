import os.path
import pathlib



from boltons import fileutils
from boltons.fileutils import FilePerms, iter_find_files
from boltons.strutils import removeprefix


BOLTONS_PATH = os.path.dirname(os.path.abspath(fileutils.__file__))


def test_fileperms():
    up = FilePerms()
    up.other = ''
    up.user = 'xrw'
    up.group = 'rrrwx'
    try:
        up.other = 'nope'
    except ValueError:
        # correctly raised ValueError on invalid chars
        pass

    assert repr(up) == "FilePerms(user='rwx', group='rwx', other='')"
    assert up.user == 'rwx'
    assert oct(int(up)) == '0o770'

    assert int(FilePerms()) == 0


def test_atomicsaver_pathlike(tmp_path):
    dest = tmp_path / 'output.bin'
    with fileutils.AtomicSaver(dest) as f:
        f.write(b'pathlike works')
    assert dest.read_bytes() == b'pathlike works'


def test_iter_find_files_pathlike():
    boltons_path = pathlib.Path(BOLTONS_PATH)
    results = list(iter_find_files(boltons_path, patterns=['*.py']))
    basenames = [os.path.basename(p) for p in results]
    assert 'fileutils.py' in basenames


def test_iter_find_files():
    def _to_baseless_list(paths):
        return [removeprefix(p, BOLTONS_PATH).lstrip(os.path.sep) for p in paths]

    assert 'fileutils.py' in _to_baseless_list(iter_find_files(BOLTONS_PATH, patterns=['*.py']))

    boltons_parent = os.path.dirname(BOLTONS_PATH)
    assert 'fileutils.py' in _to_baseless_list(iter_find_files(boltons_parent, patterns=['*.py']))
    assert 'fileutils.py' not in _to_baseless_list(iter_find_files(boltons_parent, patterns=['*.py'], max_depth=0))


def test_rotate_file_no_rotation(tmp_path):
    file_path = tmp_path / 'test_file.txt'
    fileutils.rotate_file(file_path)
    assert not file_path.exists()


def test_rotate_file_one_rotation(tmp_path):
    file_path = tmp_path / 'test_file.txt'
    file_path.write_text('test content')
    assert file_path.exists()

    fileutils.rotate_file(file_path)
    assert not file_path.exists()
    assert (tmp_path / 'test_file.1.txt').exists()


def test_rotate_file_full_rotation(tmp_path):
    file_path = tmp_path / 'test_file.txt'
    file_path.write_text('test content 0')
    for i in range(1, 5):
        cur_path = tmp_path / f'test_file.{i}.txt'
        cur_path.write_text(f'test content {i}')
        assert cur_path.exists()

    fileutils.rotate_file(file_path, keep=5)
    assert not file_path.exists()

    for i in range(1, 5):
        cur_path = tmp_path / f'test_file.{i}.txt'
        assert cur_path.read_text() == f'test content {i-1}'

    assert not (tmp_path / 'test_file.5.txt').exists()

def test_rotate_file_full_rotation_no_ext(tmp_path):
    file_path = tmp_path / 'test_file'
    file_path.write_text('test content 0')
    for i in range(1, 5):
        cur_path = tmp_path / f'test_file.{i}'
        cur_path.write_text(f'test content {i}')
        assert cur_path.exists()

    fileutils.rotate_file(file_path, keep=5)
    assert not file_path.exists()

    for i in range(1, 5):
        cur_path = tmp_path / f'test_file.{i}'
        assert cur_path.read_text() == f'test content {i-1}'

    assert not (tmp_path / 'test_file.5').exists()



def test_fileperms_from_int_roundtrip_and_groups():
    from boltons.fileutils import FilePerms
    assert int(FilePerms.from_int(0o007)) == 0o007
    p = FilePerms.from_int(0o070)
    assert (p.user, p.group, p.other) == ('', 'rwx', '')
    assert int(p) == 0o070


def test_fileperms_revoke_updates_integer():
    from boltons.fileutils import FilePerms
    p = FilePerms.from_int(0o600)
    p.user = 'r'
    assert int(p) == 0o400


def test_atomic_saver_flush_failure_cleans_up(tmp_path, monkeypatch):
    import os
    import pytest
    from boltons.fileutils import AtomicSaver
    dest = str(tmp_path / 'dest.txt')
    saver = AtomicSaver(dest)

    def boom(fd):
        raise OSError('fsync failed')
    monkeypatch.setattr(os, 'fsync', boom)
    with pytest.raises(OSError):
        with saver:
            saver.part_file.write('x')
    assert saver.part_file.closed
    assert not os.path.exists(saver.part_path)
    assert not os.path.exists(dest)


def test_iter_find_files_trailing_separator(tmp_path):
    import os
    from boltons.fileutils import iter_find_files
    (tmp_path / 'a.txt').write_text('x')
    (tmp_path / 'sub').mkdir()
    (tmp_path / 'sub' / 'b.txt').write_text('x')
    (tmp_path / 'sub' / 'deep').mkdir()
    (tmp_path / 'sub' / 'deep' / 'c.txt').write_text('x')
    d = str(tmp_path)
    for depth in (0, 1, None):
        plain = {os.path.normpath(f) for f in iter_find_files(d, '*.txt', max_depth=depth)}
        slash = {os.path.normpath(f) for f in iter_find_files(d + os.sep, '*.txt', max_depth=depth)}
        assert plain == slash
