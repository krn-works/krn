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

    function testClause1AssocInReplacesNonArrayNestedValue()
    {
        $this->assertSame(['foo' => ['bar' => 'x']], assoc_in(['foo' => 5], ['foo', 'bar'], 'x'));
    }

    function testClause2AssocInBuildsMissingLevelOverNull()
    {
        $this->assertSame(['foo' => ['bar' => 'new value']], assoc_in(['foo' => null], ['foo', 'bar'], 'new value'));
    }

    function testClause3AssocInReplacesScalarWithArray()
    {
        $this->assertSame(['a' => ['b' => ['c' => 1]]], assoc_in(['a' => 'str'], ['a', 'b', 'c'], 1));
    }

    function testClause4ExistingAssocInCasesPass()
    {
        $this->assertSame(['foo' => ['bar' => ['baz' => 'n']]], assoc_in(['foo' => ['bar' => ['baz' => 'v']]], ['foo', 'bar', 'baz'], 'n'));
    }

    function testClause5AssocInSourceFixed()
    {
        $this->assertSame(['k' => ['z' => true]], assoc_in(['k' => false], ['k', 'z'], true));
    }

    function testClause6ExistingTestsUnchanged()
    {
        $this->assertSame(['key' => 'value'], assoc_in(['key' => 'value'], [], 'x'));
    }
}
