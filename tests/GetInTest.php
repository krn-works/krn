<?php

namespace igorw;

class GetInTest extends \PHPUnit_Framework_TestCase
{
    /** @dataProvider provideGetIn */
    function testGetIn($expected, $array, $keys, $default = null)
    {
        $this->assertSame($expected, get_in($array, $keys, $default));
    }

    function provideGetIn()
    {
        $single = ['key' => 'value'];
        $nested = ['foo' => ['bar' => ['baz' => 'value']]];
        $list   = [['name' => 'foo']];

        return [
            ['value', $single, ['key'], 'default'],
            [['bar' => ['baz' => 'value']], $nested, ['foo'], 'default'],
            [['baz' => 'value'], $nested, ['foo', 'bar'], 'default'],
            ['value', $nested, ['foo', 'bar', 'baz'], 'default'],
            ['default', $nested, ['foo', 'bar', 'bang'], 'default'],
            ['default', $nested, ['non_existent'], 'default'],
            [null, $nested, ['non_existent']],
            [$nested, $nested, [], 'default'],
            [$nested, $nested, []],
            ['foo', $list, [0, 'name']],
            [null, ['foo' => null], ['foo'], 'err'],
        ];
    }

    function testClause1()
    {
        $this->assertSame('default', get_in(['foo' => null], ['foo', 'bar'], 'default'));
        $this->assertSame('default', get_in(['key' => 'value'], ['key', 'x'], 'default'));
    }

    function testClause2()
    {
        $this->assertSame(null, get_in(['foo' => null], ['foo', 'bar']));
        $this->assertSame('d', get_in(['a' => ['b' => 5]], ['a', 'b', 'c'], 'd'));
    }

    function testClause3()
    {
        $id = function ($x) { return $x; };
        foreach ([['foo' => null], ['foo' => 'str']] as $array) {
            try {
                update_in($array, ['foo', 'bar'], $id);
                $this->assertSame('exception', 'none');
            } catch (\InvalidArgumentException $e) {
                $this->assertSame(1, 1);
            }
        }
    }

    function testClause4()
    {
        $nested = ['foo' => ['bar' => 1]];
        $this->assertSame(1, get_in($nested, ['foo', 'bar']));
        $this->assertSame(null, get_in(['foo' => null], ['foo'], 'err'));
        $this->assertSame('d', get_in($nested, ['x', 'y'], 'd'));
    }

    function testClause5()
    {
        $this->assertSame('d', get_in(['k' => 1], ['k', 'x'], 'd'));
    }

    function testClause6()
    {
        $this->assertSame('d', get_in(['k' => 'v'], ['k', 'x', 'y'], 'd'));
    }

    /** @dataProvider provideUpdateIn */
    function testUpdateIn($expected, $array, $keys, $fn, array $args = [])
    {
        $this->assertSame($expected, call_user_func_array('igorw\update_in', array_merge([$array, $keys, $fn], $args)));
    }

    function provideUpdateIn()
    {
        $nested = ['foo' => ['bar' => ['baz' => 40]]];
        $single = ['key' => 'value'];

        $add = function ($a, $b) { return $a + $b; };
        $identity = function ($x) { return $x; };

        return [
            [['foo' => ['bar' => ['baz' => 42]]], $nested, ['foo', 'bar', 'baz'], $add, [2]],
            [['foo' => ['bar' => ['baz' => 40]]], $nested, ['foo', 'bar', 'baz'], $identity],
            [['foo' => ['bar' => ['baz' => 40]]], $nested, [], $identity],
            [['key' => 'value'], $single, [], $identity],
            [['foo' => null], ['foo' => null], ['foo'], $identity],
        ];
    }

    /**
     * @dataProvider provideInvalidUpdateIn
     * @expectedException InvalidArgumentException
     */
    function testInvalidUpdateIn($expected, $array, $keys, $fn, array $args = [])
    {
        $this->assertSame($expected, call_user_func_array('igorw\update_in', array_merge([$array, $keys, $fn], $args)));
    }

    function provideInvalidUpdateIn()
    {
        $nested = ['foo' => ['bar' => ['baz' => 40]]];

        $add = function ($a, $b) { return $a + $b; };
        $identity = function ($x) { return $x; };

        return [
            [['foo' => ['bar' => ['baz' => 40]]], $nested, ['non_existent'], $identity],
            [['foo' => ['bar' => ['baz' => 40]]], $nested, ['non', 'existent'], $identity],
        ];
    }

    /** @dataProvider provideAssocIn */
    function testAssocIn($expected, $array, $keys, $value)
    {
        $this->assertSame($expected, assoc_in($array, $keys, $value));
    }

    function provideAssocIn()
    {
        $nested = ['foo' => ['bar' => ['baz' => 'value']]];
        $single = ['key' => 'value'];
        $empty  = [];

        return [
            [['foo' => ['bar' => ['baz' => 'new value']]], $nested, ['foo', 'bar', 'baz'], 'new value'],
            [['key' => 'value'], $single, [], 'new value'],
            [['foo' => ['bar' => 'new value']], $empty, ['foo', 'bar'], 'new value'],
            [['foo' => 'new value'], ['foo' => null], ['foo'], 'new value'],
            [['foo' => ['bar' => 'new value']], ['foo' => null], ['foo', 'bar'], 'new value'],
        ];
    }
}
