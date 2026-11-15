<?php

namespace igorw;

class AssocInScalarTest extends \PHPUnit_Framework_TestCase
{
    function testAssocInReplacesScalarOnPath()
    {
        $this->assertSame(['foo' => ['bar' => 'new value']], assoc_in(['foo' => 'x'], ['foo', 'bar'], 'new value'));
        $this->assertSame(['foo' => ['bar' => ['baz' => 1]]], assoc_in(['foo' => 5], ['foo', 'bar', 'baz'], 1));
    }
}
