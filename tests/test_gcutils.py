import sys
import time


if '__pypy__' not in sys.builtin_module_names:
    # pypy's gc really is different

    from boltons.gcutils import get_all, toggle_gc_postcollect

    def test_get_all():
        class TestType:
            pass

        tt = TestType()

        assert len(get_all(TestType)) == 1
        assert len(get_all(bool)) == 0
        return

    def test_toggle_gc_postcollect():
        COUNT = int(1e6)

        start = time.time()
        with toggle_gc_postcollect:
            x = [{} for x in range(COUNT)]
        no_gc_time = time.time() - start

        start = time.time()
        x = [{} for x in range(COUNT)]
        with_gc_time = time.time() - start

        time_diff = no_gc_time < with_gc_time


import gc

import pytest

from boltons.gcutils import GCToggler, toggle_gc
from boltons.typeutils import get_all_subclasses


@pytest.mark.skipif('__pypy__' in sys.builtin_module_names, reason='pypy gc')
def test_get_all_subtypes():
    class Base:
        pass

    class Sub(Base):
        pass

    b, s = Base(), Sub()
    from boltons.gcutils import get_all as ga
    assert {id(x) for x in ga(Base)} == {id(b), id(s)}
    assert [x for x in ga(Base, include_subtypes=False)] == [b]


@pytest.mark.parametrize('initial', [True, False])
def test_toggler_restores_state(initial):
    t = GCToggler()
    try:
        gc.enable() if initial else gc.disable()
        with toggle_gc:
            assert not gc.isenabled()
        assert gc.isenabled() == initial
        with t:
            with t:
                assert not gc.isenabled()
            assert not gc.isenabled()
        assert gc.isenabled() == initial
    finally:
        gc.enable()


def test_subclasses_custom_metaclass():
    class Meta(type):
        def __subclasses__(cls):
            return 'bogus'

    class A(metaclass=Meta):
        pass

    class B(A):
        pass

    class C(B):
        pass

    assert get_all_subclasses(A) == [B, C]
